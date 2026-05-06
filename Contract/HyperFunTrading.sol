// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

interface ICoreWriter {
    function sendRawAction(bytes memory data) external;
}

interface IHyperFunFactory {
    function owner() external view returns (address);
    function getGlobalSettings() external view returns (
        uint256 tradingFeeBps,
        uint256 maxPremiumBps,
        uint256 maxDiscountBps,
        uint256 minDepositUsdc,
        uint256 rebalanceLowBps,
        uint256 rebalanceHighBps,
        uint256 reserveRatioBps,
        uint256 minReserveRatioBps
    );
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface ICoreDepositWallet {
    function deposit(uint256 amount, uint32 destinationDex) external;
}

interface IHyperFunToken {
    function leader() external view returns (address);
    function apiWallets(address) external view returns (bool);
    function totalSupply() external view returns (uint256);
    function admin() external view returns (address);
    function executeL1Action(bytes calldata action) external;
    function depositToL1(uint256 amount) external;
    function totalPSUsdc() external view returns (uint256);
    // reserveRatioBps, rebalanceLowBps, rebalanceHighBps, minReserveRatioBps
    // are now read from Factory.getGlobalSettings()
}

/// @title HyperFunTrading - Trading module for HyperFunToken
/// @notice Handles L1 trading operations (open/close positions, Spot/Perp transfers)
contract HyperFunTrading is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    // L1 Precompiles
    address public constant PRECOMPILE_PERP_POSITION = 0x0000000000000000000000000000000000000800;
    address public constant PRECOMPILE_SPOT = 0x0000000000000000000000000000000000000801;
    address public constant PRECOMPILE_WITHDRAWABLE = 0x0000000000000000000000000000000000000803;
    address public constant PRECOMPILE_ORACLE = 0x0000000000000000000000000000000000000807;
    address public constant PRECOMPILE_PERP_ASSET_INFO = 0x000000000000000000000000000000000000080a;
    address public constant PRECOMPILE_ACCOUNT_MARGIN_SUMMARY = 0x000000000000000000000000000000000000080F;

    ICoreWriter public constant CORE_WRITER = ICoreWriter(0x3333333333333333333333333333333333333333);

    // USDC L1 System Address (token index 0)
    address public constant USDC_L1_SYSTEM = 0x2000000000000000000000000000000000000000;

    // USDC and deposit addresses
    address public constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address public constant CORE_DEPOSIT_WALLET = 0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;

    // CoreWriter action IDs
    uint24 constant ACTION_LIMIT_ORDER = 1;
    uint24 constant ACTION_CANCEL_BY_OID = 10;  // Cancel order by oid (asset, oid)
    uint24 constant ACTION_SPOT_SEND = 6;
    uint24 constant ACTION_USD_CLASS_TRANSFER = 7;
    uint24 constant ACTION_ADD_API_WALLET = 9;
    uint24 constant ACTION_SEND_ASSET = 13;  // V47: Transfer assets between DEXs

    uint8 constant TIF_GTC = 2;
    uint8 constant TIF_IOC = 3;

    // State
    address public vault;
    address public factory;  // Factory address for upgrade authorization

    // V39: API Wallet with expiration
    struct ApiWalletInfo {
        bool active;
        uint256 expiresAt;    // Unix timestamp when wallet expires
        string name;
    }
    mapping(address => ApiWalletInfo) public apiWalletInfo;

    // Legacy mapping for backwards compatibility (deprecated, use apiWalletInfo)
    mapping(address => bool) public apiWallets;

    // V41: Order nonce for unique cloid (client order id)
    uint128 public orderNonce;

    // API Wallet duration limits
    uint256 public constant MIN_API_WALLET_DURATION = 60 days;
    uint256 public constant MAX_API_WALLET_DURATION = 180 days;

    // Events
    event OrderSent(uint32 indexed asset, bool isBuy, uint64 size, uint64 price);
    event OrderCancelled(uint32 indexed asset, uint64 oid);
    event ApiWalletAdded(address indexed apiWallet, string name, uint256 expiresAt);  // V39: added expiration
    event ApiWalletRemoved(address indexed apiWallet);
    event ApiWalletRenewed(address indexed apiWallet, uint256 newExpiresAt);  // V39
    event FundsTransferred(bool toPerp, uint64 amount);
    event WithdrawnFromL1(uint256 amount);
    event Rebalanced(bool toL1, uint256 amount, uint256 newRatioBps);
    event DepositedToL1(uint256 amount);
    event ReserveLow(uint256 currentBalance, uint256 totalAssets);
    event TransferToBuilderDex(uint32 indexed dexIndex, uint64 amount);    // V47
    event TransferFromBuilderDex(uint32 indexed dexIndex, uint64 amount);  // V47

    modifier onlyAdmin() {
        require(msg.sender == IHyperFunToken(vault).admin(), "Not admin");
        _;
    }

    modifier onlyVaultOrLeader() {
        require(
            msg.sender == vault ||
            msg.sender == IHyperFunToken(vault).leader() ||
            _isApiWalletValid(msg.sender),
            "Not authorized"
        );
        _;
    }

    /// @notice Check if API wallet is valid (active and not expired)
    function _isApiWalletValid(address wallet) internal view returns (bool) {
        ApiWalletInfo storage info = apiWalletInfo[wallet];
        // Check new system first
        if (info.active && block.timestamp < info.expiresAt) {
            return true;
        }
        // Fallback to legacy mapping (for wallets added before V39)
        // Legacy wallets have no expiration (backwards compatible)
        return apiWallets[wallet];
    }

    modifier onlyVault() {
        require(msg.sender == vault, "Only vault");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _vault, address _admin, address _factory) public initializer {
        require(_vault != address(0), "!V");
        require(_admin != address(0), "!A");
        require(_factory != address(0), "!F");
        __Ownable_init(_admin);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        vault = _vault;
        factory = _factory;
    }

    function _authorizeUpgrade(address) internal override {
        // Only factory owner can upgrade - protects investors from malicious leader upgrades
        require(factory != address(0), "No factory");
        require(msg.sender == IHyperFunFactory(factory).owner(), "Only factory owner");
    }

    // ============ Trading Functions ============

    /// @notice Normalize size to valid precision based on szDecimals
    /// @dev Input size is in 1e8 format, output is also 1e8 but rounded to valid szDecimals precision
    /// @param asset Asset index
    /// @param size Size in 1e8 format (e.g., 10.5 SUI = 1050000000)
    /// @return Normalized size in 1e8 format, rounded to valid szDecimals precision
    function _normalizeSize(uint32 asset, uint64 size) internal view returns (uint64) {
        uint32 szDec = getSzDecimals(asset);

        // Calculate the precision step in 1e8 format
        // For SUI (szDecimals=1): step = 10^(8-1) = 10^7 = 10000000 (0.1 SUI in 1e8)
        // For SOL (szDecimals=2): step = 10^(8-2) = 10^6 = 1000000 (0.01 SOL in 1e8)
        uint256 step = 10 ** (8 - szDec);

        // Round to nearest valid step
        uint256 rounded = (uint256(size) / step) * step;

        return uint64(rounded);
    }

    /// @notice Execute market order with custom leverage
    /// @param asset Asset index
    /// @param isBuy True for long, false for short
    /// @param size Size in 1e8 format
    /// @param price Price in 1e8 format (with 3% slippage for market orders)
    /// @param leverage Custom leverage (1-maxLeverage), 0 = use max leverage
    function executeMarketOrder(uint32 asset, bool isBuy, uint64 size, uint64 price, uint32 leverage) external onlyVaultOrLeader nonReentrant {
        require(IHyperFunToken(vault).totalSupply() > 0, "No deposits");

        // Normalize size to valid precision based on szDecimals
        uint64 normalizedSize = _normalizeSize(asset, size);
        require(normalizedSize > 0, "Size too small");

        // Auto-transfer from Spot to Perp if needed (only for increasing positions)
        _ensurePerpMargin(asset, isBuy, price, normalizedSize, leverage);

        _sendOrder(asset, isBuy, price, normalizedSize, false, TIF_IOC);
        emit OrderSent(asset, isBuy, normalizedSize, price);
        // Note: Don't call _returnToSpot() here because L1 order hasn't executed yet
        // Only do EVM ↔ L1 Spot rebalance
        _autoRebalanceInternal();
    }

    /// @notice Execute market order (backwards compatible - uses max leverage)
    function executeMarketOrder(uint32 asset, bool isBuy, uint64 size, uint64 price) external onlyVaultOrLeader nonReentrant {
        require(IHyperFunToken(vault).totalSupply() > 0, "No deposits");
        uint64 normalizedSize = _normalizeSize(asset, size);
        require(normalizedSize > 0, "Size too small");
        _ensurePerpMargin(asset, isBuy, price, normalizedSize, 0);
        _sendOrder(asset, isBuy, price, normalizedSize, false, TIF_IOC);
        emit OrderSent(asset, isBuy, normalizedSize, price);
        // Note: Don't call _returnToSpot() here because L1 order hasn't executed yet
        _autoRebalanceInternal();
    }

    /// @notice Execute limit order with custom leverage
    /// @param leverage Custom leverage (1-maxLeverage), 0 = use max leverage
    function executeLimitOrder(uint32 asset, bool isBuy, uint64 size, uint64 price, uint32 leverage) external onlyVaultOrLeader nonReentrant {
        require(IHyperFunToken(vault).totalSupply() > 0, "No deposits");

        // Normalize size to valid precision based on szDecimals
        uint64 normalizedSize = _normalizeSize(asset, size);
        require(normalizedSize > 0, "Size too small");

        _ensurePerpMargin(asset, isBuy, price, normalizedSize, leverage);
        _sendOrder(asset, isBuy, price, normalizedSize, false, TIF_GTC);
        emit OrderSent(asset, isBuy, normalizedSize, price);
        // Note: Don't call _returnToSpot() here because L1 order hasn't executed yet
        _autoRebalanceInternal();
    }

    /// @notice Execute limit order WITHOUT margin check - for split orders
    /// @dev IMPORTANT: Caller must ensure margin is pre-transferred to L1 Perp
    /// @dev This function ONLY sends the order, no other L1 actions
    /// @dev Use this for split orders to avoid "multiple L1 actions per TX" issue
    function executeLimitOrderRaw(uint32 asset, bool isBuy, uint64 size, uint64 price) external onlyVaultOrLeader nonReentrant {
        require(IHyperFunToken(vault).totalSupply() > 0, "No deposits");

        // Normalize size to valid precision based on szDecimals
        uint64 normalizedSize = _normalizeSize(asset, size);
        require(normalizedSize > 0, "Size too small");

        // ONLY send the order - no margin transfer, no rebalance
        // This ensures only ONE L1 action per EVM TX
        _sendOrder(asset, isBuy, price, normalizedSize, false, TIF_GTC);
        emit OrderSent(asset, isBuy, normalizedSize, price);
    }

    /// @notice Execute limit order (backwards compatible - uses max leverage)
    function executeLimitOrder(uint32 asset, bool isBuy, uint64 size, uint64 price) external onlyVaultOrLeader nonReentrant {
        require(IHyperFunToken(vault).totalSupply() > 0, "No deposits");
        uint64 normalizedSize = _normalizeSize(asset, size);
        require(normalizedSize > 0, "Size too small");
        _ensurePerpMargin(asset, isBuy, price, normalizedSize, 0);
        _sendOrder(asset, isBuy, price, normalizedSize, false, TIF_GTC);
        emit OrderSent(asset, isBuy, normalizedSize, price);
        // Note: Don't call _returnToSpot() here because L1 order hasn't executed yet
        _autoRebalanceInternal();
    }

    /// @notice Execute close order with reduceOnly option
    /// @param reduceOnly If true, order will only reduce position (won't flip to opposite side)
    function executeCloseOrderAdvanced(uint32 asset, bool isBuy, uint64 size, uint64 price, bool reduceOnly) external onlyVaultOrLeader nonReentrant {
        uint64 normalizedSize = _normalizeSize(asset, size);
        require(normalizedSize > 0, "Size too small");

        _sendOrder(asset, isBuy, price, normalizedSize, reduceOnly, TIF_IOC);
        emit OrderSent(asset, isBuy, normalizedSize, price);

        // Sweep excess funds from Perp back to Spot after close
        _returnToSpot();
        _autoRebalanceInternal();
    }

    /// @notice Execute multiple limit orders in a single transaction (for split orders / DCA)
    /// @param asset Asset index
    /// @param isBuy True for long, false for short
    /// @param sizes Array of sizes in 1e8 format
    /// @param prices Array of prices in 1e8 format
    /// @param leverage Custom leverage (1-maxLeverage), 0 = use max leverage
    function batchLimitOrders(
        uint32 asset,
        bool isBuy,
        uint64[] calldata sizes,
        uint64[] calldata prices,
        uint32 leverage
    ) external onlyVaultOrLeader nonReentrant {
        require(IHyperFunToken(vault).totalSupply() > 0, "No deposits");
        require(sizes.length == prices.length, "Array length mismatch");
        require(sizes.length > 0 && sizes.length <= 20, "Invalid order count");

        // Calculate total size for margin
        uint64 totalSize = 0;
        for (uint i = 0; i < sizes.length; i++) {
            uint64 normalizedSize = _normalizeSize(asset, sizes[i]);
            require(normalizedSize > 0, "Size too small");
            totalSize += normalizedSize;
        }

        // Ensure margin for total position (use middle price for estimation)
        uint64 avgPrice = prices[prices.length / 2];
        _ensurePerpMargin(asset, isBuy, avgPrice, totalSize, leverage);

        // Execute all orders
        for (uint i = 0; i < sizes.length; i++) {
            uint64 normalizedSize = _normalizeSize(asset, sizes[i]);
            _sendOrder(asset, isBuy, prices[i], normalizedSize, false, TIF_GTC);
            emit OrderSent(asset, isBuy, normalizedSize, prices[i]);
        }

        _autoRebalanceInternal();
    }

    /// @notice Close position using L1 precompile data
    /// @param asset Asset index
    /// @param slippageBps Slippage in basis points (100 = 1%, 5000 = 50%)
    /// @param reduceOnly If true, order will only reduce position (won't flip to opposite side)
    function closePositionAdvanced(uint32 asset, uint32 slippageBps, bool reduceOnly) external onlyVaultOrLeader nonReentrant {
        _closePositionInternal(asset, slippageBps, reduceOnly);
    }

    /// @notice Internal close position logic
    /// @param reduceOnly If true, ensures order only reduces position
    function _closePositionInternal(uint32 asset, uint32 slippageBps, bool reduceOnly) internal {
        require(slippageBps >= 100 && slippageBps <= 5000, "Slippage 1-50%");

        (int64 szi, ) = getL1PositionFull(asset);
        require(szi != 0, "No L1 position");

        uint32 szDec = getSzDecimals(asset);
        uint256 sizeMultiplier = 10 ** (8 - szDec);
        uint64 absSzi = szi < 0 ? uint64(-szi) : uint64(szi);
        uint64 closeSize = uint64(uint256(absSzi) * sizeMultiplier);

        bool isBuy = szi < 0;  // If SHORT, buy to close

        uint64 oraclePrice = getOraclePrice(asset);
        require(oraclePrice > 0, "Oracle price is 0");

        // Oracle price format: price_USD * 10^(6-szDec)
        // Convert to 1e8 format: oraclePrice * 10^(2+szDec)
        uint256 priceMultiplier = 10 ** (2 + szDec);
        uint256 currentPrice = uint256(oraclePrice) * priceMultiplier;

        // Apply slippage: BUY = +slippage, SELL = -slippage
        uint256 rawClosePrice = isBuy ?
            (currentPrice * (10000 + slippageBps)) / 10000 :
            (currentPrice * (10000 - slippageBps)) / 10000;

        // Round price to 2 decimal places for Hyperliquid
        uint64 closePrice = uint64((rawClosePrice / 1000000) * 1000000);

        _sendOrder(asset, isBuy, closePrice, closeSize, reduceOnly, TIF_IOC);
        emit OrderSent(asset, isBuy, closeSize, closePrice);

        // Sweep excess funds from Perp back to Spot after close
        _returnToSpot();
        _autoRebalanceInternal();
    }

    /// @notice Cancel a pending limit order by order ID
    /// @param asset The asset index (e.g., 0 for BTC, 1 for ETH)
    /// @param oid The order ID to cancel (from Hyperliquid openOrders API)
    function cancelOrder(uint32 asset, uint64 oid) external onlyVaultOrLeader nonReentrant {
        bytes memory innerPayload = abi.encode(asset, oid);
        bytes memory action = abi.encodePacked(uint8(1), ACTION_CANCEL_BY_OID, innerPayload);
        IHyperFunToken(vault).executeL1Action(action);
        emit OrderCancelled(asset, oid);
    }

    // ============ API Wallet Functions ============

    /// @notice Add API wallet with expiration (V39)
    /// @param apiWallet The wallet address to authorize
    /// @param name Name for the API wallet
    /// @param durationDays Duration in days (60-180), or 0 for no expiration
    function addApiWallet(address apiWallet, string calldata name, uint256 durationDays) external {
        require(msg.sender == IHyperFunToken(vault).leader(), "Not leader");
        require(apiWallet != address(0), "Invalid");
        require(!_isApiWalletValid(apiWallet), "Already active");

        uint256 expiresAt;

        if (durationDays == 0) {
            // V39: No expiration (unlimited)
            expiresAt = type(uint256).max;
        } else {
            // V39: Validate duration (60-180 days)
            uint256 durationSeconds = durationDays * 1 days;
            require(durationSeconds >= MIN_API_WALLET_DURATION, "Min 60 days");
            require(durationSeconds <= MAX_API_WALLET_DURATION, "Max 180 days");
            expiresAt = block.timestamp + durationSeconds;
        }

        // Store in new system
        apiWalletInfo[apiWallet] = ApiWalletInfo({
            active: true,
            expiresAt: expiresAt,
            name: name
        });

        // Register on L1
        bytes memory action = abi.encodePacked(uint8(1), ACTION_ADD_API_WALLET, abi.encode(apiWallet, name));
        IHyperFunToken(vault).executeL1Action(action);

        emit ApiWalletAdded(apiWallet, name, expiresAt);
    }

    /// @notice Renew API wallet expiration (V39)
    /// @param apiWallet The wallet to renew
    /// @param durationDays New duration in days (60-180), or 0 for no expiration
    function renewApiWallet(address apiWallet, uint256 durationDays) external {
        require(msg.sender == IHyperFunToken(vault).leader(), "Not leader");

        ApiWalletInfo storage info = apiWalletInfo[apiWallet];
        require(info.active, "Not active");

        uint256 newExpiresAt;

        if (durationDays == 0) {
            // V39: Set to no expiration (unlimited)
            newExpiresAt = type(uint256).max;
        } else {
            // V39: Validate duration (60-180 days)
            uint256 durationSeconds = durationDays * 1 days;
            require(durationSeconds >= MIN_API_WALLET_DURATION, "Min 60 days");
            require(durationSeconds <= MAX_API_WALLET_DURATION, "Max 180 days");
            newExpiresAt = block.timestamp + durationSeconds;
        }

        info.expiresAt = newExpiresAt;

        emit ApiWalletRenewed(apiWallet, newExpiresAt);
    }

    /// @notice Remove API wallet authorization
    /// @dev Removes from EVM tracking only. L1 API wallet registration is permanent (Hyperliquid limitation).
    ///      However, this is still secure because all trading functions check on EVM before any L1 action.
    function removeApiWallet(address apiWallet) external {
        require(msg.sender == IHyperFunToken(vault).leader(), "Not leader");
        require(_isApiWalletValid(apiWallet), "Not active");

        // Remove from new system
        ApiWalletInfo storage info = apiWalletInfo[apiWallet];
        info.active = false;
        info.expiresAt = 0;

        // Also clear legacy mapping (for wallets added before V39)
        apiWallets[apiWallet] = false;

        // Note: L1 API wallet cannot be removed (Hyperliquid has no remove action)
        // But security is maintained because EVM check happens before any L1 action

        emit ApiWalletRemoved(apiWallet);
    }

    // ============ Fund Transfer Functions ============

    /// @notice Transfer USDC from L1 Spot to L1 Perp
    function transferToPerp(uint64 amount) external onlyVaultOrLeader {
        bytes memory action = abi.encodePacked(
            uint8(1),
            ACTION_USD_CLASS_TRANSFER,
            abi.encode(amount, true)
        );
        IHyperFunToken(vault).executeL1Action(action);
        emit FundsTransferred(true, amount);
    }

    /// @notice Transfer USDC from L1 Perp to L1 Spot
    function transferFromPerp(uint64 amount) external onlyVaultOrLeader {
        bytes memory action = abi.encodePacked(
            uint8(1),
            ACTION_USD_CLASS_TRANSFER,
            abi.encode(amount, false)
        );
        IHyperFunToken(vault).executeL1Action(action);
        emit FundsTransferred(false, amount);
    }

    /// @notice Sweep all withdrawable from Perp to Spot
    function sweepToSpot() external onlyVaultOrLeader {
        _returnToSpot();
    }

    /// @notice Force return all withdrawable from Perp to Spot
    function forceReturnToSpot() external onlyVaultOrLeader {
        uint64 w = _getWithdrawable();
        require(w > 0, "Nothing to withdraw");
        bytes memory action = abi.encodePacked(uint8(1), ACTION_USD_CLASS_TRANSFER, abi.encode(w, false));
        IHyperFunToken(vault).executeL1Action(action);
    }

    // ============ Internal Functions ============

    /// @notice Internal rebalance trigger
    function _triggerRebalance() internal {
        // Step 1: Return excess from Perp to Spot (keep only required margin)
        _returnToSpot();
        // Step 2: Rebalance EVM ↔ L1 Spot
        _autoRebalanceInternal();
    }

    function _sendOrder(uint32 asset, bool isBuy, uint64 price, uint64 size, bool reduceOnly, uint8 tif) internal {
        // V41: Use unique cloid for each order to prevent L1 from treating them as duplicates
        orderNonce++;
        uint128 cloid = orderNonce;
        bytes memory innerPayload = abi.encode(asset, isBuy, price, size, reduceOnly, tif, cloid);
        bytes memory action = abi.encodePacked(uint8(1), ACTION_LIMIT_ORDER, innerPayload);
        IHyperFunToken(vault).executeL1Action(action);
    }

    /// @notice Ensure sufficient margin in Perp for a trade
    /// @dev Calculates margin based on TOTAL position after trade, not just the new trade
    /// @param asset Asset index
    /// @param isBuy Trade direction
    /// @param price Price in 1e8 format
    /// @param size Size in 1e8 format (new trade size)
    /// @param leverage Custom leverage (1-maxLeverage), 0 = use max leverage
    function _ensurePerpMargin(uint32 asset, bool isBuy, uint64 price, uint64 size, uint32 leverage) internal {
        // Check current position to determine if this trade increases or decreases exposure
        int64 currentPos = getL1Position(asset);

        // If we have a position and trade is in opposite direction, this is reducing/closing
        if (currentPos != 0) {
            bool isLong = currentPos > 0;
            bool isReducing = (isLong && !isBuy) || (!isLong && isBuy);
            if (isReducing) return; // No margin transfer needed for reducing
        }

        // Get max leverage for this asset
        uint32 maxLev = getMaxLeverage(asset);

        // Determine effective leverage: use custom if provided and valid, else use max
        uint32 effectiveLev;
        if (leverage > 0 && leverage <= maxLev) {
            effectiveLev = leverage;
        } else {
            effectiveLev = maxLev;
        }

        // Calculate TOTAL position size after this trade (in 1e8 format)
        // Current position is in szDecimals format, need to convert to 1e8
        uint32 szDec = getSzDecimals(asset);
        uint256 sizeMultiplier = 10 ** (8 - szDec);
        uint256 currentPosAbs = currentPos >= 0 ? uint256(uint64(currentPos)) : uint256(uint64(-currentPos));
        uint256 currentPos1e8 = currentPosAbs * sizeMultiplier;

        // New total position = current + new trade (both in 1e8)
        uint256 totalSize1e8 = currentPos1e8 + uint256(size);

        // Calculate TOTAL notional value for the entire position
        // notional = price * totalSize / 1e8 (both are in 1e8 format)
        // Result is in 1e8 format, divide by 1e2 to get 1e6 (USDC decimals)
        uint256 totalNotional = (uint256(price) * totalSize1e8) / 1e8;
        uint256 requiredMargin6 = totalNotional / 1e2 / effectiveLev;

        // Add 5% buffer for trading fees and slippage
        requiredMargin6 = (requiredMargin6 * 105) / 100;

        // Get current AVAILABLE margin in Perp (accountValue - marginUsed)
        uint256 currentPerpValue = _getAvailablePerpMargin();

        // Transfer additional margin if available is less than required
        if (currentPerpValue < requiredMargin6) {
            uint256 needed = requiredMargin6 - currentPerpValue;
            uint256 spot = getL1SpotBalance();
            if (spot > 0 && needed > 0) {
                uint64 amt = uint64(needed > spot ? spot : needed);
                bytes memory action = abi.encodePacked(uint8(1), ACTION_USD_CLASS_TRANSFER, abi.encode(amt, true));
                IHyperFunToken(vault).executeL1Action(action);
            }
        }
    }

    function _returnToSpot() internal {
        // Only transfer if Hyperliquid has withdrawable balance
        uint64 w = _getWithdrawable();
        if (w <= 1e6) return; // Nothing withdrawable

        // Calculate how much we want to keep in Perp (required margin + 0.5% buffer)
        uint256 requiredMargin = _calculateRequiredMargin();
        uint256 requiredWithBuffer = (requiredMargin * 1005) / 1000;

        // Calculate current Perp account value (total value, not available margin)
        uint256 currentPerpValue = getL1AccountValue();
        if (currentPerpValue <= requiredWithBuffer) return; // Nothing excess

        uint256 excess = currentPerpValue - requiredWithBuffer;

        // Transfer the smaller of: what we want to transfer OR what Hyperliquid allows
        uint64 transferAmount = excess < w ? uint64(excess) : w;

        if (transferAmount > 1e6) {
            // Send L1 transfer: Perp -> Spot
            // Note: We don't update trackedL1Perp here because:
            // 1. The L1 transfer might fail (Hyperliquid rejection)
            // 2. We now read actual values from precompiles instead of tracking
            bytes memory action = abi.encodePacked(uint8(1), ACTION_USD_CLASS_TRANSFER, abi.encode(transferAmount, false));
            IHyperFunToken(vault).executeL1Action(action);
        }
    }

    /// @notice Calculate total required margin for all positions
    /// @dev V45: Uses Hyperliquid's marginUsed from Account Margin Summary precompile
    /// @dev This automatically includes ALL assets (including HIP-3) with accurate L1 data
    function _calculateRequiredMargin() internal view returns (uint256) {
        // Read marginUsed directly from Account Margin Summary precompile
        // This is more accurate and includes all assets (native + HIP-3)
        (bool success, bytes memory data) = PRECOMPILE_ACCOUNT_MARGIN_SUMMARY.staticcall(
            abi.encode(uint32(0), vault)
        );

        if (success && data.length >= 32) {
            // Data: (int64 accountValue, uint64 marginUsed, uint64 ntlPos, int64 rawUsd)
            (, uint64 marginUsed, , ) = abi.decode(data, (int64, uint64, uint64, int64));
            return uint256(marginUsed);
        }
        return 0;
    }

    function _getWithdrawable() internal view returns (uint64) {
        // Withdrawable precompile returns uint64, not int256
        (bool success, bytes memory data) = PRECOMPILE_WITHDRAWABLE.staticcall(abi.encode(vault));
        if (success && data.length >= 8) {
            return abi.decode(data, (uint64));
        }
        return 0;
    }

    // ============ View Functions ============

    /// @notice Get API wallet status and expiration (V39)
    /// @return active Whether the wallet is currently active
    /// @return expiresAt Unix timestamp when wallet expires (0 = legacy, max uint256 = unlimited)
    /// @return daysRemaining Days until expiration (type(uint256).max if unlimited, 0 if expired/legacy)
    /// @return name The wallet name
    function getApiWalletStatus(address apiWallet) external view returns (
        bool active,
        uint256 expiresAt,
        uint256 daysRemaining,
        string memory name
    ) {
        ApiWalletInfo storage info = apiWalletInfo[apiWallet];

        if (info.active) {
            // New system with expiration
            expiresAt = info.expiresAt;
            name = info.name;

            if (expiresAt == type(uint256).max) {
                // Unlimited (no expiration)
                active = true;
                daysRemaining = type(uint256).max;
            } else {
                // Has expiration
                active = block.timestamp < expiresAt;
                if (active) {
                    daysRemaining = (expiresAt - block.timestamp) / 1 days;
                }
            }
        } else if (apiWallets[apiWallet]) {
            // Legacy system (no expiration)
            active = true;
            expiresAt = 0;
            daysRemaining = type(uint256).max;  // Legacy = unlimited
            name = "(legacy)";
        }
    }

    /// @notice Check if API wallet is valid (public version)
    function isApiWalletValid(address wallet) external view returns (bool) {
        return _isApiWalletValid(wallet);
    }

    function getL1SpotBalance() public view returns (uint256) {
        (bool success, bytes memory data) = PRECOMPILE_SPOT.staticcall(abi.encode(vault, uint64(0)));
        if (success && data.length >= 32) {
            (uint256 total, , ) = abi.decode(data, (uint256, uint256, uint256));
            return total / 100;  // 8 decimals to 6 decimals
        }
        return 0;
    }

    /// @notice Get Oracle price (same as getOraclePriceRaw64)
    function getOraclePrice(uint32 asset) public view returns (uint64) {
        return getOraclePriceRaw64(asset);
    }

    /// @notice Get L1 Perp account value (total value, for display/getTotalAssets)
    /// @dev Returns value in 6 decimals (USDC format)
    /// @dev This returns the ACTUAL account value, not available margin
    function getL1AccountValue() public view returns (uint256) {
        (bool success, bytes memory data) = PRECOMPILE_ACCOUNT_MARGIN_SUMMARY.staticcall(
            abi.encode(uint32(0), vault)
        );
        if (success && data.length >= 32) {
            (int64 accountValue, , , ) = abi.decode(data, (int64, uint64, uint64, int64));
            if (accountValue <= 0) return 0;
            return uint256(uint64(accountValue));
        }
        return 0;
    }

    /// @notice Get Account Margin Summary from precompile 0x80F
    /// @dev Returns accurate L1 Perp account value including all fees
    function getAccountMarginSummary() public view returns (
        int64 accountValue,
        uint64 marginUsed,
        uint64 ntlPos,
        int64 rawUsd
    ) {
        (bool success, bytes memory data) = PRECOMPILE_ACCOUNT_MARGIN_SUMMARY.staticcall(
            abi.encode(uint32(0), vault)
        );
        if (success && data.length >= 32) {
            (accountValue, marginUsed, ntlPos, rawUsd) = abi.decode(data, (int64, uint64, uint64, int64));
        }
    }

    /// @notice Debug function to see all components of L1 account value
    function getL1AccountValueDebug() public view returns (
        uint64 withdrawable,
        uint256 requiredMargin,
        uint256 accountValue,
        uint32 positionLeverage
    ) {
        withdrawable = _getWithdrawable();
        requiredMargin = _calculateRequiredMargin();
        accountValue = getL1AccountValue();  // Use actual value, not available margin

        // Get leverage from first active position
        uint16[10] memory commonPerps = [uint16(0), 1, 2, 3, 4, 5, 6, 7, 8, 9];
        for (uint i = 0; i < commonPerps.length; i++) {
            (bool s2, bytes memory d2) = PRECOMPILE_PERP_POSITION.staticcall(abi.encode(vault, commonPerps[i]));
            if (s2 && d2.length >= 64) {
                // Position struct: (int64 szi, uint64 entryNtl, int64 isolatedRawUsd, uint32 leverage, bool isIsolated)
                (int64 szi, , , uint32 actualLev, ) = abi.decode(d2, (int64, uint64, int64, uint32, bool));
                if (szi != 0) {
                    positionLeverage = actualLev;
                    break;
                }
            }
        }
    }

    /// @notice Debug function for isolated margin positions
    function getIsolatedPositionDebug(uint32 asset) public view returns (
        int64 szi,
        uint64 entryNtl,
        int64 isolatedRawUsd,
        uint32 leverage,
        bool isIsolated,
        uint64 oraclePrice,
        int256 currentNotional,
        int256 positionValue
    ) {
        (bool success, bytes memory data) = PRECOMPILE_PERP_POSITION.staticcall(abi.encode(vault, asset));
        if (success && data.length >= 64) {
            (szi, entryNtl, isolatedRawUsd, leverage, isIsolated) = abi.decode(data, (int64, uint64, int64, uint32, bool));
        }
        oraclePrice = getOraclePriceRaw64(asset);
        if (szi != 0 && oraclePrice > 0) {
            int256 absSzi = szi >= 0 ? int256(szi) : -int256(szi);
            currentNotional = absSzi * int256(uint256(oraclePrice));
            if (isIsolated) {
                positionValue = currentNotional + int256(isolatedRawUsd);
            }
        }
    }

    /// @notice Get AVAILABLE margin in L1 Perp (for _ensurePerpMargin calculations)
    /// @dev Returns accountValue - marginUsed (what's available for new orders)
    /// @dev DO NOT use this for display or getTotalAssets - use getL1AccountValue() instead
    function _getAvailablePerpMargin() internal view returns (uint256) {
        (bool success, bytes memory data) = PRECOMPILE_ACCOUNT_MARGIN_SUMMARY.staticcall(
            abi.encode(uint32(0), vault)
        );

        if (success && data.length >= 32) {
            (int64 accountValue, uint64 marginUsed, , ) = abi.decode(data, (int64, uint64, uint64, int64));
            if (accountValue <= 0) return 0;

            // Available margin = accountValue - marginUsed
            uint256 totalValue = uint256(uint64(accountValue));
            if (marginUsed > 0 && totalValue > marginUsed) {
                return totalValue - marginUsed;
            }
            return totalValue;
        }
        return 0;
    }

    /// @notice Get actual L1 position size from precompile (in szDecimals format)
    /// @dev For SOL (szDecimals=2): szi=100 means 1.0 SOL
    function getL1Position(uint32 asset) public view returns (int64) {
        (bool success, bytes memory data) = PRECOMPILE_PERP_POSITION.staticcall(abi.encode(vault, asset));
        if (success && data.length >= 8) {
            return abi.decode(data, (int64));
        }
        return 0;
    }

    /// @notice Get full L1 position data from precompile
    /// @return szi Position size in szDecimals format
    /// @return entryNtl Entry notional in 1e6 format
    function getL1PositionFull(uint32 asset) public view returns (int64 szi, uint64 entryNtl) {
        (bool success, bytes memory data) = PRECOMPILE_PERP_POSITION.staticcall(abi.encode(vault, asset));
        if (success && data.length >= 64) {
            (szi, entryNtl) = abi.decode(data, (int64, uint64));
        }
        return (szi, entryNtl);
    }

    /// @notice Get szDecimals for an asset from 0x80A precompile
    /// @dev szDecimals determines position size precision (e.g., 2 for SOL means szi=100 is 1.0 SOL)
    function getSzDecimals(uint32 asset) public view returns (uint32) {
        (bool success, bytes memory data) = PRECOMPILE_PERP_ASSET_INFO.staticcall(abi.encode(asset));
        if (success && data.length >= 128) {
            // Data layout: 0x60 = szDecimals (96 bytes from start)
            uint32 szDec;
            assembly {
                szDec := mload(add(data, 128)) // 32 + 96 = 128 (skip length + offset to szDecimals)
            }
            return szDec;
        }
        return 8; // Default to 8 decimals
    }

    /// @notice Preview normalized size for an asset (view function for frontend)
    /// @param asset Asset index
    /// @param size Input size in 1e8 format
    /// @return normalizedSize Size rounded to valid szDecimals precision
    /// @return szDecimals The asset's szDecimals value
    /// @return minSize Minimum valid size in 1e8 format (1 unit of szDecimals)
    function previewNormalizedSize(uint32 asset, uint64 size) public view returns (
        uint64 normalizedSize,
        uint32 szDecimals,
        uint64 minSize
    ) {
        szDecimals = getSzDecimals(asset);
        uint256 step = 10 ** (8 - szDecimals);
        normalizedSize = uint64((uint256(size) / step) * step);
        minSize = uint64(step);
    }

    /// @notice Get raw Oracle price from 0x807 (returns uint64)
    function getOraclePriceRaw64(uint32 asset) public view returns (uint64) {
        (bool success, bytes memory data) = PRECOMPILE_ORACLE.staticcall(abi.encode(asset));
        if (success && data.length >= 8) {
            return abi.decode(data, (uint64));
        }
        return 0;
    }

    /// @notice Get max leverage for an asset from 0x80A precompile
    function getMaxLeverage(uint32 asset) public view returns (uint32) {
        (bool success, bytes memory data) = PRECOMPILE_PERP_ASSET_INFO.staticcall(abi.encode(asset));
        if (success && data.length >= 160) {
            // Data layout (with outer offset at 0x00):
            // 0x00: outer offset (0x20)
            // 0x20: string offset (0xa0)
            // 0x40: marginTableId
            // 0x60: szDecimals
            // 0x80: maxLeverage <-- we want this
            // 0xa0: onlyIsolated
            // Read maxLeverage directly from position 0x80 (128 bytes from start)
            uint32 maxLev;
            assembly {
                maxLev := mload(add(data, 160)) // 32 + 128 = 160 (skip length + offset to maxLev)
            }
            return maxLev > 0 ? maxLev : 10;
        }
        return 10; // Default 10x leverage
    }

    /// @notice Get raw L1 Spot balance in 8 decimals (for spotSend)
    function getL1SpotBalanceRaw() public view returns (uint256) {
        (bool success, bytes memory data) = PRECOMPILE_SPOT.staticcall(abi.encode(vault, uint64(0)));
        if (success && data.length >= 32) {
            (uint256 total, , ) = abi.decode(data, (uint256, uint256, uint256));
            return total;  // 8 decimals
        }
        return 0;
    }

    // ============ Admin Functions ============

    /// @notice Refill EVM reserve from L1 Perp
    function refillReserve(uint64 amount) external onlyAdmin {
        bytes memory action = abi.encodePacked(uint8(1), ACTION_USD_CLASS_TRANSFER, abi.encode(amount, false));
        IHyperFunToken(vault).executeL1Action(action);
        emit FundsTransferred(false, amount);
    }

    /// @notice Withdraw USDC from L1 Perp to EVM in one transaction
    /// @param amount Amount in 6 decimals (USDC format)
    function withdrawPerpToEVM(uint64 amount) external onlyAdmin {
        // Action 1: Perp → Spot
        bytes memory action1 = abi.encodePacked(
            uint8(1),
            ACTION_USD_CLASS_TRANSFER,
            abi.encode(amount, false)
        );
        IHyperFunToken(vault).executeL1Action(action1);

        // Action 2: Spot → EVM
        bytes memory action2 = abi.encodePacked(
            uint8(1),
            ACTION_SPOT_SEND,
            abi.encode(USDC_L1_SYSTEM, uint64(0), amount)
        );
        IHyperFunToken(vault).executeL1Action(action2);

        emit WithdrawnFromL1(amount);
    }

    /// @notice Withdraw all withdrawable from L1 Perp to EVM
    function withdrawAllPerpToEVM() external onlyAdmin {
        uint64 withdrawable = _getWithdrawable();
        require(withdrawable > 0, "Nothing to withdraw");

        uint64 amount = withdrawable;

        bytes memory action1 = abi.encodePacked(
            uint8(1),
            ACTION_USD_CLASS_TRANSFER,
            abi.encode(amount, false)
        );
        IHyperFunToken(vault).executeL1Action(action1);

        bytes memory action2 = abi.encodePacked(
            uint8(1),
            ACTION_SPOT_SEND,
            abi.encode(USDC_L1_SYSTEM, uint64(0), amount)
        );
        IHyperFunToken(vault).executeL1Action(action2);

        emit WithdrawnFromL1(amount);
    }

    /// @notice Step 1 only - Perp to Spot
    function withdrawStep1_PerpToSpot(uint64 amount) external onlyAdmin {
        bytes memory action = abi.encodePacked(
            uint8(1),
            ACTION_USD_CLASS_TRANSFER,
            abi.encode(amount, false)
        );
        IHyperFunToken(vault).executeL1Action(action);
    }

    /// @notice Step 2 only - Spot to EVM
    /// @param amount6 Amount in 6 decimals (will be converted to 8 decimals)
    function withdrawStep2_SpotToEVM(uint64 amount6) external onlyAdmin {
        uint64 amount8 = amount6 * 100;
        bytes memory action = abi.encodePacked(
            uint8(1),
            ACTION_SPOT_SEND,
            abi.encode(USDC_L1_SYSTEM, uint64(0), amount8)
        );
        IHyperFunToken(vault).executeL1Action(action);
        emit WithdrawnFromL1(amount6);
    }

    /// @notice Send all Spot USDC to EVM (leaves 0.01 USDC buffer)
    function withdrawAllSpotToEVM() external onlyAdmin {
        uint256 spotRaw = getL1SpotBalanceRaw();
        require(spotRaw > 1000000, "No Spot balance"); // Need > 0.01 USDC

        // Leave 0.01 USDC (1000000 in 8 decimals) as buffer
        uint64 amountToSend = uint64(spotRaw - 1000000);

        bytes memory action = abi.encodePacked(
            uint8(1),
            ACTION_SPOT_SEND,
            abi.encode(USDC_L1_SYSTEM, uint64(0), amountToSend)
        );
        IHyperFunToken(vault).executeL1Action(action);
        emit WithdrawnFromL1(spotRaw / 100);
    }

    /// @notice Update vault reference (for migration)
    function setVault(address _vault) external onlyOwner {
        require(_vault != address(0), "Invalid vault");
        vault = _vault;
    }

    // ============ Rebalance Functions ============

    /// @notice Get total assets (EVM + L1 Spot + L1 Perp - Pending Sells) in 18 decimals
    function getTotalAssets() public view returns (uint256) {
        uint256 l1SpotValue = getL1SpotBalance() * 1e12;
        uint256 l1PerpValue = getL1AccountValue() * 1e12;
        uint256 evmUsdcBalance = IERC20(USDC).balanceOf(vault) * 1e12;
        uint256 pendingOut = IHyperFunToken(vault).totalPSUsdc() * 1e12;
        uint256 total = l1PerpValue + l1SpotValue + evmUsdcBalance;
        return total > pendingOut ? total - pendingOut : 0;
    }

    /// @notice Deposit USDC from vault to L1
    function _depositUsdcToL1(uint256 amount) internal {
        IHyperFunToken(vault).depositToL1(amount);
        emit DepositedToL1(amount);
    }

    /// @notice Auto-rebalance EVM/L1 ratio to target 50%
    /// @dev Called by VaultCore after buy/sell
    function autoRebalance() external onlyVault {
        _autoRebalanceInternal();
    }

    /// @notice Internal auto-rebalance logic
    /// @dev V43: Accounts for pending sells (totalPSUsdc) to avoid incorrect rebalancing
    function _autoRebalanceInternal() internal {
        uint256 evmUsdc6 = IERC20(USDC).balanceOf(vault);
        uint256 l1Spot6 = getL1SpotBalance();
        uint256 l1Perp6 = getL1AccountValue();

        // V43: Subtract pending sells from EVM balance
        // These funds are reserved for users waiting to claim, not available for rebalancing
        uint256 pendingSells6 = IHyperFunToken(vault).totalPSUsdc();
        uint256 availableEvm6 = evmUsdc6 > pendingSells6 ? evmUsdc6 - pendingSells6 : 0;

        uint256 total6 = availableEvm6 + l1Spot6 + l1Perp6;

        if (total6 == 0) return;

        // Read settings from Factory
        (, , , , uint256 rebalanceLowBps, uint256 rebalanceHighBps, uint256 reserveRatioBps, ) = IHyperFunFactory(factory).getGlobalSettings();

        uint256 currentRatioBps = (availableEvm6 * 10000) / total6;

        if (currentRatioBps >= rebalanceLowBps && currentRatioBps <= rebalanceHighBps) {
            return;
        }

        uint256 targetEvm6 = (total6 * reserveRatioBps) / 10000;

        if (currentRatioBps > rebalanceHighBps) {
            // V43: Only rebalance if we have excess AVAILABLE (after reserving for pending sells)
            if (availableEvm6 > targetEvm6) {
                uint256 excess6 = availableEvm6 - targetEvm6;
                if (excess6 > 0) {
                    _depositUsdcToL1(excess6);
                    emit Rebalanced(true, excess6, (targetEvm6 * 10000) / total6);
                }
            }
        } else if (currentRatioBps < rebalanceLowBps) {
            uint256 needed6 = targetEvm6 > availableEvm6 ? targetEvm6 - availableEvm6 : 0;
            if (needed6 > 0 && l1Spot6 >= needed6) {
                uint64 needed8 = uint64(needed6 * 100);
                bytes memory action = abi.encodePacked(
                    uint8(1),
                    ACTION_SPOT_SEND,
                    abi.encode(USDC_L1_SYSTEM, uint64(0), needed8)
                );
                IHyperFunToken(vault).executeL1Action(action);
                emit Rebalanced(false, needed6, (targetEvm6 * 10000) / total6);
                emit WithdrawnFromL1(needed6);
            }
        }
    }

    /// @notice Check reserve ratio and emit warning if low
    function checkReserve() external view returns (bool isLow) {
        uint256 total = getTotalAssets();
        if (total == 0) return false;

        uint256 evmUsdc = IERC20(USDC).balanceOf(vault) * 1e12;
        uint256 currentRatio = (evmUsdc * 10000) / total;
        (, , , , , , , uint256 minReserveRatioBps) = IHyperFunFactory(factory).getGlobalSettings();

        return currentRatio < minReserveRatioBps;
    }

    // ============ V46: Builder Perp Functions (asset >= 100000) ============

    /// @notice Transfer USDC from native perp to a builder DEX (HIP-3)
    /// @dev Required before trading on builder DEXs like xyz
    /// @param dexIndex The builder DEX index (e.g., 1 for xyz)
    /// @param amount Amount in 6 decimals (USDC format)
    function transferToBuilderDex(uint32 dexIndex, uint64 amount) external onlyVaultOrLeader nonReentrant {
        require(dexIndex > 0, "Invalid dex");
        require(amount > 0, "Invalid amount");

        // Action 13: Send asset between DEXs
        // Format: (destination, subAccount, source_dex, destination_dex, token, wei)
        // source_dex = 0 (native perp), destination_dex = dexIndex (e.g., 1 for xyz)
        // token = 0 (USDC), wei in 8 decimals
        uint64 amount8 = amount * 100; // Convert 6 decimals to 8 decimals
        bytes memory innerPayload = abi.encode(
            vault,           // destination: transfer to self
            address(0),      // subAccount: not used
            uint32(0),       // source_dex: native perp
            dexIndex,        // destination_dex: builder DEX (e.g., 1 for xyz)
            uint64(0),       // token: USDC
            amount8          // amount in 8 decimals (wei)
        );
        bytes memory action = abi.encodePacked(uint8(1), ACTION_SEND_ASSET, innerPayload);
        IHyperFunToken(vault).executeL1Action(action);

        emit TransferToBuilderDex(dexIndex, amount);
    }

    /// @notice Transfer USDC from a builder DEX back to native perp
    /// @param dexIndex The builder DEX index (e.g., 1 for xyz)
    /// @param amount Amount in 6 decimals (USDC format)
    function transferFromBuilderDex(uint32 dexIndex, uint64 amount) external onlyVaultOrLeader nonReentrant {
        require(dexIndex > 0, "Invalid dex");
        require(amount > 0, "Invalid amount");

        uint64 amount8 = amount * 100; // Convert 6 decimals to 8 decimals
        bytes memory innerPayload = abi.encode(
            vault,           // destination: transfer to self
            address(0),      // subAccount: not used
            dexIndex,        // source_dex: builder DEX
            uint32(0),       // destination_dex: native perp
            uint64(0),       // token: USDC
            amount8          // amount in 8 decimals (wei)
        );
        bytes memory action = abi.encodePacked(uint8(1), ACTION_SEND_ASSET, innerPayload);
        IHyperFunToken(vault).executeL1Action(action);

        emit TransferFromBuilderDex(dexIndex, amount);
    }

    /// @notice Execute order for Builder Deployed Perps (HIP-3)
    /// @dev EVM precompiles don't support asset >= 100000, so caller must provide params
    /// @param asset Builder perp asset index (e.g., 110003 for xyz:GOLD)
    /// @param isBuy True for long, false for short
    /// @param size Size in 1e8 format
    /// @param price Limit price in 1e8 format
    /// @param szDecimals Asset's szDecimals (from API)
    /// @param maxLeverage Asset's max leverage (from API, typically 10-20)
    /// @param isLimit True for limit order (GTC), false for market order (IOC)
    function executeOrderBuilder(
        uint32 asset,
        bool isBuy,
        uint64 size,
        uint64 price,
        uint32 szDecimals,
        uint32 maxLeverage,
        bool isLimit
    ) external onlyVaultOrLeader nonReentrant {
        require(asset >= 100000, "Use standard function");
        require(IHyperFunToken(vault).totalSupply() > 0, "No deposits");
        require(szDecimals <= 8, "Invalid szDecimals");
        require(maxLeverage > 0 && maxLeverage <= 100, "Invalid leverage");

        // Normalize size using provided szDecimals
        uint256 step = 10 ** (8 - szDecimals);
        uint64 normalizedSize = uint64((uint256(size) / step) * step);
        require(normalizedSize > 0, "Size too small");

        // Ensure margin (simplified: only for new positions)
        _ensurePerpMarginBuilder(price, normalizedSize, maxLeverage);

        // Send order
        _sendOrder(asset, isBuy, price, normalizedSize, false, isLimit ? TIF_GTC : TIF_IOC);
        emit OrderSent(asset, isBuy, normalizedSize, price);

        _autoRebalanceInternal();
    }

    /// @notice Close position for Builder Perp
    /// @param asset Builder perp asset index
    /// @param isBuy True if closing short (buy), false if closing long (sell)
    /// @param size Size to close in 1e8 format
    /// @param price Limit price in 1e8 format
    /// @param szDecimals Asset's szDecimals
    function closePositionBuilder(
        uint32 asset,
        bool isBuy,
        uint64 size,
        uint64 price,
        uint32 szDecimals
    ) external onlyVaultOrLeader nonReentrant {
        require(asset >= 100000, "Use standard function");

        uint256 step = 10 ** (8 - szDecimals);
        uint64 normalizedSize = uint64((uint256(size) / step) * step);
        require(normalizedSize > 0, "Size too small");

        _sendOrder(asset, isBuy, price, normalizedSize, true, TIF_IOC);
        emit OrderSent(asset, isBuy, normalizedSize, price);

        _returnToSpot();
        _autoRebalanceInternal();
    }

    /// @notice Simplified margin check for builder perps
    function _ensurePerpMarginBuilder(uint64 price, uint64 size, uint32 leverage) internal {
        uint256 notional = (uint256(price) * uint256(size)) / 1e8;
        uint256 requiredMargin6 = (notional * 105) / (100 * leverage * 100); // 5% buffer

        uint256 currentPerpValue = _getAvailablePerpMargin();
        if (currentPerpValue < requiredMargin6) {
            uint256 needed = requiredMargin6 - currentPerpValue;
            uint256 spot = getL1SpotBalance();
            if (spot > 0 && needed > 0) {
                uint64 amt = uint64(needed > spot ? spot : needed);
                bytes memory action = abi.encodePacked(uint8(1), ACTION_USD_CLASS_TRANSFER, abi.encode(amt, true));
                IHyperFunToken(vault).executeL1Action(action);
            }
        }
    }
}
