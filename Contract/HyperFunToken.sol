// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICoreWriter {
    function sendRawAction(bytes memory data) external;
}

interface ICoreDepositWallet {
    function deposit(uint256 amount, uint32 destinationDex) external;
}

interface IHyperFunTrading {
    function getL1AccountValue() external view returns (uint256);
    function getL1SpotBalance() external view returns (uint256);
    function getTotalAssets() external view returns (uint256);
    function autoRebalance() external;
}

interface IHyperFunFactory {
    function owner() external view returns (address);
    function treasury() external view returns (address);
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
    function getGlobalSettingsExt() external view returns (
        uint256 maxBuyBps,
        uint256 navVirtualAssets,
        uint256 navVirtualShares,
        bool exitFeeEnabled
    );
    struct ExitFeeTier {
        uint256 daysHeld;
        uint256 feeBps;
    }
    function getGlobalExitFeeTiers() external view returns (ExitFeeTier[] memory);
    function globalBcVirtualMinimumBps() external view returns (uint256);
    function globalMaxBcRatioBps() external view returns (uint256);  // V39: Max BC ratio
    function getGlobalNavVirtualDynamic() external view returns (
        uint256 mode,
        uint256 multiplierBps,
        uint256 minimum
    );
    function getGlobalNavVirtualParams() external view returns (
        uint256 mode,
        uint256 minMultiplierBps,
        uint256 maxMultiplierBps,
        uint256 targetAssets,
        uint256 minimum
    );
    // V37: Graduation Tier System
    // V38: Added squaredRatioBps for progressive squared effect decay
    struct GraduationTier {
        uint256 threshold;
        uint256 bcVirtual;
        uint256 navMinMulBps;
        uint256 navMaxMulBps;
        uint256 squaredRatioBps;  // V38: Squared effect weight (10000=100%, 0=linear)
    }
    function getGraduationTiers() external view returns (GraduationTier[] memory);
    function getGraduationTierCount() external view returns (uint256);
    function getGraduationTier(uint256 index) external view returns (
        uint256 threshold,
        uint256 bcVirtual,
        uint256 navMinMulBps,
        uint256 navMaxMulBps,
        uint256 squaredRatioBps
    );
    function isGraduationTieredMode() external view returns (bool);
}

/// @title HyperFunToken - Core Vault with Standard Bonding Curve (Constant Product AMM)
/// @notice Uses x*y=k formula like Pump.fun. Price impact = (1 + X/V)² - 1
contract HyperFunToken is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    ERC20Upgradeable
{
    // ============ Constants ============
    uint256 public constant BPS = 10000;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_FEE = 3000; // 30%

    address public constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address public constant CORE_DEPOSIT_WALLET = 0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;
    ICoreWriter public constant CORE_WRITER = ICoreWriter(0x3333333333333333333333333333333333333333);

    // USDC L1 System Address (token index 0)
    address public constant USDC_L1_SYSTEM = 0x2000000000000000000000000000000000000000;

    // L1 Precompiles
    address public constant PRECOMPILE_SPOT = 0x0000000000000000000000000000000000000801;

    // CoreWriter action IDs
    uint24 constant ACTION_SPOT_SEND = 6;
    uint24 constant ACTION_ADD_API_WALLET = 9;
    uint24 constant ACTION_APPROVE_BUILDER_FEE = 12;

    // ============ Structs ============
    struct DepositRecord {
        uint256 depositAmount;
        uint256 depositSharePrice;
    }

    // Entry record for Performance Fee calculation
    struct EntryRecord {
        uint256 weightedEntryNav;  // Weighted average entry NAV
        uint256 totalTokens;       // Total tokens held (for weighted calculation)
    }

    struct PSSell {
        uint256 usdcAmount;
        uint256 feeAmount;
        uint256 timestamp;
    }

    // Exit fee tier structure (time-based decay)
    struct ExitFeeTier {
        uint256 daysHeld;      // Minimum days held for this tier
        uint256 feeBps;        // Fee in basis points (100 = 1%)
    }

    // User purchase tracking for exit fee calculation
    struct UserPurchaseInfo {
        uint256 totalTokens;           // Total tokens bought (for weighted average)
        uint256 weightedTimestamp;     // Weighted average purchase timestamp
        uint256 lastPurchaseTime;      // Last purchase timestamp
    }

    // ============ State Variables ============

    // Vault info
    address public leader;
    uint256 public feeBps;
    address public admin;

    // Trading module
    address public tradingModule;

    // Bonding Curve state (changes with each buy/sell)
    uint256 public virtualBase;
    uint256 public virtualTokens;

    // Dynamic scaling baseline (per-vault)
    uint256 public initialAssets;

    // All other settings read from Factory:
    // tradingFeeBps, maxPremiumBps, maxDiscountBps, minDepositUsdc
    // rebalanceLowBps, rebalanceHighBps, reserveRatioBps, minReserveRatioBps
    // maxBuyBps, navVirtualAssets, navVirtualShares, exitFeeEnabled, exitFeeTiers

    // Accounting
    uint256 public totalDeposits;
    uint256 public totalVolume;  // Total trading volume (18 decimals)
    mapping(address => DepositRecord) public depositRecords;

    // Platform settings (treasury read from Factory)
    uint256 public protocolFee;
    bool public paused;

    // PS sells
    mapping(address => PSSell) public pendingSells;
    uint256 public totalPSUsdc;

    // User purchase tracking for exit fee calculation
    mapping(address => UserPurchaseInfo) public userPurchaseInfo;

    // Exit fee tiers, enabled, navVirtual now read from Factory

    // Factory address - only factory owner can upgrade implementations
    address public factory;

    // Metadata URI (IPFS or URL pointing to JSON metadata with image, description, etc.)
    string public metadataURI;

    // Entry records for Performance Fee calculation
    mapping(address => EntryRecord) public entryRecords;

    // V40: Time-Weighted NAV (TWAP) for price protection against liquidation spikes
    uint256 public twapNav;           // Smoothed NAV value (18 decimals)
    uint256 public twapNavTime;       // Last update timestamp
    uint256 public twapMaxChangePerMin;  // Max NAV change per minute in bps (default: 500 = 5%)

    // ============ Events ============
    event Deposited(address indexed user, uint256 usdcAmount, uint256 shares);
    event TokenBought(address indexed user, uint256 usdcIn, uint256 tokensOut, uint256 price);
    event TokenSold(address indexed user, uint256 tokensIn, uint256 usdcOut, uint256 price);
    event ReserveLow(uint256 currentBalance, uint256 totalAssets);
    event SellPS(address indexed user, uint256 usdcAmount, uint256 feeAmount);
    event SellClaimed(address indexed user, uint256 usdcAmount);
    event DepositedToL1(uint256 amount);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
    event WithdrawnFromL1(uint256 amount);
    event TradingModuleChanged(address indexed oldModule, address indexed newModule);
    event ExitFeeCharged(address indexed user, uint256 feeAmount, uint256 feeBps, uint256 daysHeld);
    event ExitFeeConfigChanged(bool enabled, address recipient);
    event Rebalanced(bool toL1, uint256 amount, uint256 newRatioBps);
    event NavVirtualChanged(uint256 virtualAssets, uint256 virtualShares);
    event MetadataUpdated(string newUri);
    event PerformanceFeeMinted(
        address indexed user,      // Seller
        address indexed leader,    // Fee recipient
        uint256 feeTokens,         // Minted token amount
        uint256 nav                // NAV at the time
    );
    event BuilderFeeApproved(address indexed builder, uint64 maxFeeRate);

    // ============ Modifiers ============
    modifier onlyAdmin() {
        require(msg.sender == admin, "!Admin");
        _;
    }

    modifier onlyLeader() {
        require(msg.sender == leader, "!Leader");
        _;
    }

    modifier onlyTradingModule() {
        require(msg.sender == tradingModule, "!TM");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    modifier onlyFactoryOwner() {
        require(factory != address(0) && (msg.sender == factory || msg.sender == IHyperFunFactory(factory).owner()), "!FO");
        _;
    }

    /// @notice Get global settings from Factory
    function _getSettings() internal view returns (
        uint256 tradingFeeBps, uint256 maxPremiumBps, uint256 maxDiscountBps,
        uint256 minDepositUsdc, uint256 rebalanceLowBps, uint256 rebalanceHighBps,
        uint256 reserveRatioBps, uint256 minReserveRatioBps
    ) {
        return IHyperFunFactory(factory).getGlobalSettings();
    }

    /// @notice Get extended settings from Factory
    function _getSettingsExt() internal view returns (
        uint256 maxBuyBps, uint256 navVirtualAssets, uint256 navVirtualShares, bool exitFeeEnabled
    ) {
        return IHyperFunFactory(factory).getGlobalSettingsExt();
    }

    /// @notice Get treasury from Factory
    function _getTreasury() internal view returns (address) {
        return IHyperFunFactory(factory).treasury();
    }

    // ============ Initializer ============
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @notice Initialize with configurable BC parameters
    /// @param _virtualBase BC virtual base (e.g., 2_000_000 * 1e18)
    /// @param _virtualTokens BC virtual tokens (e.g., 2_000_000 * 1e18)
    /// @param _initialAssets Initial assets baseline (e.g., 1000 * 1e18)
    function initialize(
        address _leader,
        string calldata _name,
        string calldata _symbol,
        uint256 _feeBps,
        address, // _treasury - now read from Factory
        address _admin,
        address _tradingModule,
        address _factory,
        uint256 _virtualBase,
        uint256 _virtualTokens,
        uint256 _initialAssets
    ) public initializer {
        require(_leader != address(0), "!L");
        require(_feeBps <= MAX_FEE, "Fee");
        require(_admin != address(0), "!A");
        require(_factory != address(0), "!F");
        require(_virtualBase > 0 && _virtualTokens > 0 && _initialAssets > 0, "!BC");

        __Ownable_init(_admin);
        factory = _factory;
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __ERC20_init(_name, _symbol);

        leader = _leader;
        admin = _admin;
        feeBps = _feeBps;
        tradingModule = _tradingModule;
        protocolFee = 100;

        // Bonding curve initial state (from parameters, not hardcoded)
        virtualBase = _virtualBase;
        virtualTokens = _virtualTokens;
        initialAssets = _initialAssets;

        // All other settings read from Factory

        // Register leader as API wallet on L1
        bytes memory action = abi.encodePacked(uint8(1), ACTION_ADD_API_WALLET, abi.encode(_leader, _name));
        CORE_WRITER.sendRawAction(action);
    }

    function _authorizeUpgrade(address) internal override {
        // Only factory owner can upgrade - protects investors from malicious leader upgrades
        require(factory != address(0), "No factory");
        require(msg.sender == IHyperFunFactory(factory).owner(), "Only factory owner");
    }

    // ============ Exit Fee Functions ============

    /// @notice Calculate exit fee based on holding duration (reads from Factory)
    function calculateExitFee(address user) public view returns (uint256 exitFeeBpsResult, uint256 daysHeldResult) {
        (, , , bool exitFeeEnabled) = _getSettingsExt();
        IHyperFunFactory.ExitFeeTier[] memory tiers = IHyperFunFactory(factory).getGlobalExitFeeTiers();

        if (!exitFeeEnabled || tiers.length == 0) {
            return (0, 0);
        }

        UserPurchaseInfo memory info = userPurchaseInfo[user];
        if (info.weightedTimestamp == 0) {
            return (tiers[0].feeBps, 0);
        }

        daysHeldResult = (block.timestamp - info.weightedTimestamp) / 1 days;

        exitFeeBpsResult = tiers[0].feeBps;
        for (uint256 i = tiers.length; i > 0; i--) {
            if (daysHeldResult >= tiers[i - 1].daysHeld) {
                exitFeeBpsResult = tiers[i - 1].feeBps;
                break;
            }
        }
    }

    /// @notice Update user purchase info for exit fee tracking
    /// @param user The user buying tokens
    /// @param tokensOut The amount of tokens being purchased
    function _updatePurchaseInfo(address user, uint256 tokensOut) internal {
        UserPurchaseInfo storage info = userPurchaseInfo[user];

        if (info.totalTokens == 0) {
            // First purchase
            info.totalTokens = tokensOut;
            info.weightedTimestamp = block.timestamp;
        } else {
            // Calculate weighted average timestamp
            // newWeightedTime = (oldTotal * oldTime + newTokens * now) / (oldTotal + newTokens)
            uint256 oldTotal = info.totalTokens;
            uint256 newTotal = oldTotal + tokensOut;
            info.weightedTimestamp = (oldTotal * info.weightedTimestamp + tokensOut * block.timestamp) / newTotal;
            info.totalTokens = newTotal;
        }
        info.lastPurchaseTime = block.timestamp;
    }

    /// @notice Update user purchase info after selling tokens
    /// @param user The user selling tokens
    /// @param tokensSold The amount of tokens being sold
    function _updatePurchaseInfoAfterSell(address user, uint256 tokensSold) internal {
        UserPurchaseInfo storage info = userPurchaseInfo[user];

        if (tokensSold >= info.totalTokens) {
            // Sold all tokens, reset tracking
            info.totalTokens = 0;
            // Keep weightedTimestamp for potential future reference
        } else {
            // Partial sell - reduce total tokens but keep weighted timestamp
            info.totalTokens -= tokensSold;
        }
    }

    // ============ Entry Record Functions (for Performance Fee) ============

    /// @notice Update entry record when user buys tokens
    /// @param user The user buying tokens
    /// @param newTokens The amount of tokens being purchased
    /// @param nav The current NAV at purchase time
    function _updateEntryRecord(address user, uint256 newTokens, uint256 nav) internal {
        EntryRecord storage record = entryRecords[user];
        uint256 oldTokens = record.totalTokens;

        if (oldTokens == 0) {
            record.weightedEntryNav = nav;
            record.totalTokens = newTokens;
        } else {
            // Weighted average: (oldTokens * oldNav + newTokens * newNav) / totalTokens
            record.weightedEntryNav = (oldTokens * record.weightedEntryNav + newTokens * nav)
                                      / (oldTokens + newTokens);
            record.totalTokens = oldTokens + newTokens;
        }
    }

    /// @notice Calculate performance fee tokens to mint to leader
    /// @param user The user selling tokens
    /// @param tokens The amount of tokens being sold
    /// @param currentNav The current NAV
    /// @return feeTokens The number of tokens to mint to leader as performance fee
    function _calculatePerformanceFee(
        address user,
        uint256 tokens,
        uint256 currentNav
    ) internal view returns (uint256 feeTokens) {
        EntryRecord storage record = entryRecords[user];

        if (record.weightedEntryNav == 0 || currentNav <= record.weightedEntryNav) {
            return 0;  // No profit, no fee
        }

        // Calculate profit (in token value terms)
        // profit = tokens * (currentNav - entryNav) / PRECISION
        uint256 profitPerToken = currentNav - record.weightedEntryNav;
        uint256 totalProfit18 = (tokens * profitPerToken) / PRECISION;

        // Performance Fee = profit * feeBps / BPS
        uint256 fee18 = (totalProfit18 * feeBps) / BPS;

        // Convert to token amount: feeTokens = fee18 / currentNav
        feeTokens = (fee18 * PRECISION) / currentNav;

        return feeTokens;
    }

    /// @notice Reduce entry record after selling tokens
    /// @param user The user selling tokens
    /// @param soldTokens The amount of tokens sold
    function _reduceEntryRecord(address user, uint256 soldTokens) internal {
        EntryRecord storage record = entryRecords[user];

        if (soldTokens >= record.totalTokens) {
            // Sold all tokens, clear record
            record.weightedEntryNav = 0;
            record.totalTokens = 0;
        } else {
            // Partial sell - just reduce token count, keep weighted average
            record.totalTokens -= soldTokens;
        }
    }

    /// @notice Override ERC20 _update to handle entry NAV inheritance on transfers
    /// @dev Prevents users from transferring tokens to new addresses to reset entry NAV
    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);

        // Only handle actual transfers (not mints or burns)
        if (from != address(0) && to != address(0) && from != to) {
            EntryRecord storage fromRecord = entryRecords[from];
            EntryRecord storage toRecord = entryRecords[to];

            uint256 fromNav = fromRecord.weightedEntryNav;

            if (toRecord.totalTokens == 0) {
                // Receiver has no tokens, inherit sender's NAV
                toRecord.weightedEntryNav = fromNav;
                toRecord.totalTokens = amount;
            } else {
                // Weighted average with existing holdings
                toRecord.weightedEntryNav = (toRecord.totalTokens * toRecord.weightedEntryNav
                                            + amount * fromNav)
                                            / (toRecord.totalTokens + amount);
                toRecord.totalTokens += amount;
            }

            // Reduce sender's record
            if (amount >= fromRecord.totalTokens) {
                fromRecord.weightedEntryNav = 0;
                fromRecord.totalTokens = 0;
            } else {
                fromRecord.totalTokens -= amount;
            }
        }
    }

    // ============ Bonding Curve Functions ============

    /// @notice Get NAV based on total assets (EVM + L1 tracked balances)
    /// @dev Includes virtual assets/shares to stabilize NAV when vault is small
    /// V35: Supports dynamic NAV Virtual mode for fairer profit distribution
    /// V36: Supports auto-dynamic mode (early=low multiplier, mature=high multiplier)
    /// V37: Uses min(assets, supply) as base; supports graduation tier system
    function getNAV() public view returns (uint256) {
        uint256 supply = totalSupply();
        uint256 total = getTotalAssets();

        // V38: Always use tiered mode (simple mode removed)
        uint256 effectiveNavVirtual = _calcTieredNavVirtual(total, supply);

        uint256 totalWithVirtual = total + effectiveNavVirtual;
        uint256 supplyWithVirtual = supply + effectiveNavVirtual;

        if (supplyWithVirtual == 0) return PRECISION;
        return (totalWithVirtual * PRECISION) / supplyWithVirtual;
    }

    /// @notice Calculate NAV Virtual using graduation tiers
    /// @dev Interpolates between tier navMinMul and navMaxMul based on progress within tier
    /// @dev V43: Added minimum floor to prevent extreme NAV when vault is nearly empty
    function _calcTieredNavVirtual(uint256 assets, uint256 supply) internal view returns (uint256) {
        // V43: Minimum NAV Virtual floor - prevents extreme NAV when vault is nearly empty
        // When both assets and supply approach zero, raw NAV = assets/supply can be extreme
        // This floor ensures NAV stays reasonable (close to 1.0) for nearly empty vaults
        uint256 minNavVirtual = 1000 * PRECISION; // Minimum 1000 tokens worth

        uint256 tierCount = _getGraduationTierCount();
        if (tierCount == 0) {
            // No tiers configured, return default minimum
            return minNavVirtual;
        }

        // Find current tier
        uint256 prevThreshold = 0;
        uint256 prevNavMaxMul = 0;

        for (uint256 i = 0; i < tierCount; i++) {
            (uint256 threshold, , uint256 navMinMul, uint256 navMaxMul, ) = _getGraduationTier(i);

            if (assets < threshold) {
                // We're in this tier
                uint256 multiplierBps;
                if (i == 0) {
                    // First tier: interpolate from navMinMul to navMaxMul
                    if (threshold > 0) {
                        uint256 progress = (assets * BPS) / threshold;
                        multiplierBps = navMinMul + (progress * (navMaxMul - navMinMul)) / BPS;
                    } else {
                        multiplierBps = navMinMul;
                    }
                } else {
                    // Later tiers: interpolate from prevTier.navMaxMul to currentTier.navMaxMul
                    uint256 tierRange = threshold - prevThreshold;
                    uint256 assetsInTier = assets - prevThreshold;
                    uint256 progress = tierRange > 0 ? (assetsInTier * BPS) / tierRange : 0;
                    multiplierBps = prevNavMaxMul + (progress * (navMaxMul - prevNavMaxMul)) / BPS;
                }

                // Use min(assets, supply) as base
                uint256 baseValue = assets < supply ? assets : supply;
                uint256 navVirtual = (baseValue * multiplierBps) / BPS;
                // V43: Apply minimum floor
                return navVirtual > minNavVirtual ? navVirtual : minNavVirtual;
            }

            prevThreshold = threshold;
            prevNavMaxMul = navMaxMul;
        }

        // Beyond last tier: use last tier's navMaxMul
        (, , , uint256 lastNavMaxMul, ) = _getGraduationTier(tierCount - 1);
        uint256 finalBase = assets < supply ? assets : supply;
        uint256 navVirtual = (finalBase * lastNavMaxMul) / BPS;
        // V43: Apply minimum floor
        return navVirtual > minNavVirtual ? navVirtual : minNavVirtual;
    }

    /// @notice Get graduation tier count from Factory
    function _getGraduationTierCount() internal view returns (uint256) {
        try IHyperFunFactory(factory).getGraduationTierCount() returns (uint256 count) {
            return count;
        } catch {
            return 0;
        }
    }

    /// @notice Get a specific graduation tier from Factory (V38: added squaredRatioBps)
    function _getGraduationTier(uint256 index) internal view returns (
        uint256 threshold,
        uint256 bcVirtual,
        uint256 navMinMulBps,
        uint256 navMaxMulBps,
        uint256 squaredRatioBps
    ) {
        try IHyperFunFactory(factory).getGraduationTier(index) returns (
            uint256 t, uint256 bc, uint256 minMul, uint256 maxMul, uint256 sqRatio
        ) {
            return (t, bc, minMul, maxMul, sqRatio);
        } catch {
            return (0, 0, 0, 0, BPS); // Default to 100% squared (backwards compatible)
        }
    }

    // _getNavVirtualParams removed - V38 uses tiered mode only

    /// @notice Get raw NAV without virtual assets (for display/comparison)
    function getRawNAV() public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return PRECISION;
        uint256 total = getTotalAssets();
        return (total * PRECISION) / supply;
    }

    /// @notice V40: Get smoothed NAV using exponential moving average
    /// @dev Protects against sudden NAV spikes during liquidation events
    /// Uses half-life approach: NAV moves halfway to instant NAV every N minutes
    function getSmoothedNAV() public view returns (uint256) {
        uint256 instantNav = getNAV();

        // If no previous TWAP or first time, return instant NAV
        if (twapNav == 0 || twapNavTime == 0) {
            return instantNav;
        }

        // If instant NAV is higher than TWAP, allow immediate increase (no upside protection needed)
        if (instantNav >= twapNav) {
            return instantNav;
        }

        // Calculate time elapsed in seconds
        uint256 elapsed = block.timestamp - twapNavTime;
        if (elapsed == 0) {
            return twapNav;
        }

        // Half-life in seconds (default 600 = 10 minutes)
        // After 10 minutes, smoothed NAV moves halfway to instant NAV
        uint256 halfLife = twapMaxChangePerMin > 0 ? twapMaxChangePerMin : 600;

        // Calculate decay: gap * 0.5^periods using bit shift
        uint256 gap = twapNav - instantNav;
        uint256 periods = elapsed / halfLife;
        uint256 remaining = elapsed % halfLife;

        // Apply half-life periods via bit shift (gap >> n = gap / 2^n)
        if (periods > 0) {
            gap = periods >= 10 ? gap >> 10 : gap >> periods;
        }

        // Apply partial period (linear interpolation for remaining time)
        if (remaining > 0 && gap > 0) {
            // gap reduces by (gap/2) * (remaining/halfLife)
            uint256 partialReduction = (gap * remaining) / (halfLife * 2);
            gap = gap > partialReduction ? gap - partialReduction : 0;
        }

        // Smoothed NAV = instant NAV + remaining gap
        // This means it's between instantNav and twapNav
        return instantNav + gap;
    }

    /// @notice V40: Update TWAP NAV (called during buy/sell)
    function _updateTwapNav() internal {
        uint256 smoothed = getSmoothedNAV();
        twapNav = smoothed;
        twapNavTime = block.timestamp;
    }

    /// @notice V40: Initialize or reset TWAP NAV
    function initTwapNav() external onlyAdmin {
        twapNav = getNAV();
        twapNavTime = block.timestamp;
    }

    /// @notice V40: Set TWAP half-life in seconds
    /// @param halfLifeSeconds Half-life period (default 600 = 10 minutes)
    /// @dev After one half-life, smoothed NAV moves halfway to instant NAV
    function setTwapHalfLife(uint256 halfLifeSeconds) external onlyAdmin {
        require(halfLifeSeconds >= 60 && halfLifeSeconds <= 3600, "!Range"); // 1min - 1hour
        twapMaxChangePerMin = halfLifeSeconds; // Reusing this storage slot for half-life
    }

    /// @notice Get effective virtualTokens scaled by vault size
    /// @dev V38: Progressive squared effect decay (tiered mode only)
    /// - squaredRatioBps controls the blend between squared and linear effect
    function getEffectiveVirtualTokens() public view returns (uint256) {
        uint256 assets = getTotalAssets();
        uint256 tierBcVirtual = _calcTieredBcVirtual(assets);

        // V38: Progressive squared effect decay
        // squaredWeight = 10000 (100%): effVTokens = tierBcVirtual / ratio (full squared)
        // squaredWeight = 0 (0%): effVTokens = tierBcVirtual (linear, price tracks NAV)
        if (virtualBase > 0) {
            uint256 squaredWeightBps = _calcSquaredRatioWeight(assets);

            if (squaredWeightBps == BPS) {
                return (tierBcVirtual * virtualTokens) / virtualBase;
            } else if (squaredWeightBps == 0) {
                return tierBcVirtual;
            } else {
                // Progressive blend
                uint256 squaredPart = (tierBcVirtual * virtualTokens) / virtualBase;
                uint256 linearPart = tierBcVirtual;
                return (squaredPart * squaredWeightBps + linearPart * (BPS - squaredWeightBps)) / BPS;
            }
        }
        return tierBcVirtual;
    }

    /// @notice Get effective virtualBase scaled by vault size
    /// @dev V38: Tiered mode only
    function getEffectiveVirtualBase() public view returns (uint256) {
        uint256 assets = getTotalAssets();
        uint256 tierBcVirtual = _calcTieredBcVirtual(assets);

        // Apply stored ratio (virtualBase / virtualTokens at init = 1.0)
        if (virtualTokens > 0) {
            return (tierBcVirtual * virtualBase) / virtualTokens;
        }
        return tierBcVirtual;
    }

    /// @notice Calculate BC Virtual using graduation tiers
    /// @dev Interpolates between tier bcVirtual values based on progress within tier
    function _calcTieredBcVirtual(uint256 assets) internal view returns (uint256) {
        uint256 tierCount = _getGraduationTierCount();
        if (tierCount == 0) {
            // No tiers configured, return stored virtualBase
            return virtualBase;
        }

        // Get minimum floor
        uint256 minimumBps = IHyperFunFactory(factory).globalBcVirtualMinimumBps();
        if (minimumBps == 0) minimumBps = 500; // Fallback to 5%

        // Find current tier and interpolate
        uint256 prevThreshold = 0;
        uint256 prevBcVirtual = 0;

        for (uint256 i = 0; i < tierCount; i++) {
            (uint256 threshold, uint256 bcVirtual, , , ) = _getGraduationTier(i);

            if (assets < threshold) {
                // We're in this tier
                if (i == 0) {
                    // First tier: interpolate from minimum to tier's bcVirtual
                    uint256 minimum = (bcVirtual * minimumBps) / BPS;
                    if (threshold > 0) {
                        uint256 progress = (assets * BPS) / threshold;
                        return minimum + (progress * (bcVirtual - minimum)) / BPS;
                    }
                    return minimum;
                } else {
                    // Later tiers: interpolate from prevTier.bcVirtual to currentTier.bcVirtual
                    uint256 tierRange = threshold - prevThreshold;
                    uint256 assetsInTier = assets - prevThreshold;
                    if (tierRange > 0) {
                        uint256 progress = (assetsInTier * BPS) / tierRange;
                        return prevBcVirtual + (progress * (bcVirtual - prevBcVirtual)) / BPS;
                    }
                    return prevBcVirtual;
                }
            }

            prevThreshold = threshold;
            prevBcVirtual = bcVirtual;
        }

        // Beyond last tier: use last tier's bcVirtual
        (, uint256 lastBcVirtual, , , ) = _getGraduationTier(tierCount - 1);
        return lastBcVirtual;
    }

    /// @notice V38: Calculate squared ratio weight using graduation tiers
    /// @dev Returns the squaredRatioBps for the current tier (no interpolation within tier)
    /// - 10000 = 100% squared effect (early investor protection)
    /// - 0 = linear (price tracks NAV closely)
    function _calcSquaredRatioWeight(uint256 assets) internal view returns (uint256) {
        uint256 tierCount = _getGraduationTierCount();
        if (tierCount == 0) {
            return BPS; // Default to 100% squared for backwards compatibility
        }

        // Find current tier
        for (uint256 i = 0; i < tierCount; i++) {
            (uint256 threshold, , , , uint256 squaredRatioBps) = _getGraduationTier(i);

            if (assets < threshold) {
                // We're in this tier, use its squared ratio
                return squaredRatioBps;
            }
        }

        // Beyond last tier: use last tier's squaredRatioBps
        (, , , , uint256 lastSquaredRatio) = _getGraduationTier(tierCount - 1);
        return lastSquaredRatio;
    }

    /// @notice Get maximum USDC that can be bought in a single transaction
    function getMaxBuyUsdc() public view returns (uint256) {
        (, , , uint256 minDepositUsdc, , , , ) = _getSettings();
        (uint256 maxBuyBps, , , ) = _getSettingsExt();
        uint256 assets = getTotalAssets();
        if (assets == 0) return minDepositUsdc;

        uint256 maxUsdc18 = (assets * maxBuyBps) / BPS;
        uint256 maxUsdc6 = maxUsdc18 / 1e12;
        return maxUsdc6 > minDepositUsdc ? maxUsdc6 : minDepositUsdc;
    }

    /// @notice Get maximum tokens that can be bought based on effective virtualTokens
    function getMaxBuyTokens() public view returns (uint256) {
        uint256 effVirtualTokens = getEffectiveVirtualTokens();
        // Allow buying up to 90% of effective virtualTokens in one transaction
        return (effVirtualTokens * 9000) / BPS;
    }

    /// @notice Get current buy price using constant product formula
    /// @dev V40: Uses smoothed NAV to protect against liquidation price spikes
    function getBuyPrice() public view returns (uint256) {
        (, uint256 maxPremiumBps, uint256 maxDiscountBps, , , , , ) = _getSettings();
        // V40: Use smoothed NAV for price protection
        uint256 nav = getSmoothedNAV();
        uint256 effVirtualBase = getEffectiveVirtualBase();
        uint256 effVirtualTokens = getEffectiveVirtualTokens();

        uint256 ratio = (effVirtualBase * BPS) / effVirtualTokens;
        uint256 price = (nav * ratio) / BPS;

        uint256 maxPrice = (nav * (BPS + maxPremiumBps)) / BPS;
        if (price > maxPrice) price = maxPrice;
        uint256 minPrice = (nav * (BPS - maxDiscountBps)) / BPS;
        if (price < minPrice) price = minPrice;

        return price;
    }

    /// @notice Get current sell price (same as buy price for constant product AMM)
    /// @dev Returns the theoretical price, use getSellPriceCapped for actual withdrawable price
    function getSellPrice() public view returns (uint256) {
        return getBuyPrice(); // Constant product has same buy/sell price
    }

    /// @notice Get available liquidity for withdrawals (EVM + L1 Spot, excluding L1 Perp)
    function getAvailableLiquidity() public view returns (uint256) {
        uint256 total = IERC20(USDC).balanceOf(address(this)) + getL1SpotBalance();
        return total > totalPSUsdc ? total - totalPSUsdc : 0;
    }

    /// @notice Get sell price capped by available liquidity
    function getSellPriceCapped() public view returns (uint256) {
        uint256 theoretical = getBuyPrice();
        uint256 supply = totalSupply();
        if (supply == 0) return theoretical;
        uint256 maxPrice = (getAvailableLiquidity() * 1e12 * PRECISION) / supply;
        return theoretical < maxPrice ? theoretical : maxPrice;
    }

    /// @notice Calculate tokens out for a given USDC input
    /// @dev V40: Uses smoothed NAV for consistency with actual execution
    function calculateTokensOut(uint256 usdcIn) public view returns (uint256 tokensOut, uint256 newPrice, uint256 priceImpactBps) {
        (, uint256 maxPremiumBps, , , , , , ) = _getSettings();
        uint256 nav = getSmoothedNAV();
        uint256 effVirtualBase = getEffectiveVirtualBase();
        uint256 effVirtualTokens = getEffectiveVirtualTokens();

        uint256 virtualBaseUsdc = (effVirtualBase * nav) / PRECISION;
        uint256 usdcIn18 = usdcIn * 1e12;
        tokensOut = (effVirtualTokens * usdcIn18) / (virtualBaseUsdc + usdcIn18);

        uint256 newVirtualBaseUsdc = virtualBaseUsdc + usdcIn18;
        uint256 newVirtualTokens = effVirtualTokens - tokensOut;

        if (newVirtualTokens > 0) {
            newPrice = (newVirtualBaseUsdc * PRECISION) / newVirtualTokens;
            uint256 maxPrice = (nav * (BPS + maxPremiumBps)) / BPS;
            if (newPrice > maxPrice) newPrice = maxPrice;
        } else {
            newPrice = (nav * (BPS + maxPremiumBps)) / BPS;
        }

        uint256 oldPrice = getBuyPrice();
        if (oldPrice > 0 && newPrice > oldPrice) {
            priceImpactBps = ((newPrice - oldPrice) * BPS) / oldPrice;
        }
    }

    /// @notice Calculate USDC out for selling tokens
    /// @dev V40: Uses smoothed NAV for consistency with actual execution
    function calculateUsdcOut(uint256 tokensIn) public view returns (uint256 usdcOut, uint256 newPrice, uint256 priceImpactBps) {
        (, , uint256 maxDiscountBps, , , , , ) = _getSettings();
        uint256 nav = getSmoothedNAV();
        uint256 effVirtualBase = getEffectiveVirtualBase();
        uint256 effVirtualTokens = getEffectiveVirtualTokens();

        uint256 virtualBaseUsdc = (effVirtualBase * nav) / PRECISION;
        uint256 usdcOut18 = (virtualBaseUsdc * tokensIn) / (effVirtualTokens + tokensIn);
        usdcOut = usdcOut18 / 1e12;

        uint256 newVirtualBaseUsdc = virtualBaseUsdc - usdcOut18;
        uint256 newVirtualTokens = effVirtualTokens + tokensIn;

        newPrice = (newVirtualBaseUsdc * PRECISION) / newVirtualTokens;
        uint256 minPrice = (nav * (BPS - maxDiscountBps)) / BPS;
        if (newPrice < minPrice) newPrice = minPrice;

        uint256 oldPrice = getBuyPrice();
        if (oldPrice > 0 && newPrice < oldPrice) {
            priceImpactBps = ((oldPrice - newPrice) * BPS) / oldPrice;
        }
    }

    /// @notice Buy tokens with slippage protection
    /// @param usdcAmount Amount of USDC to spend
    /// @param minTokensOut Minimum tokens expected (0 = no slippage check)
    function buy(uint256 usdcAmount, uint256 minTokensOut) external whenNotPaused nonReentrant {
        (uint256 tradingFeeBps, , , uint256 minDepositUsdc, , , , ) = _getSettings();
        require(usdcAmount >= minDepositUsdc, "Min");

        // V40: Use smoothed NAV for price protection
        uint256 nav = getSmoothedNAV();
        uint256 effVirtualBase = getEffectiveVirtualBase();
        uint256 effVirtualTokens = getEffectiveVirtualTokens();

        // V47: Entry NAV should match the NAV used for token calculation (Smoothed NAV)
        // This ensures performance fee is calculated based on actual buy price
        uint256 entryNav = nav;  // nav = getSmoothedNAV() from line 916

        require(IERC20(USDC).transferFrom(msg.sender, address(this), usdcAmount), "Tx");

        uint256 amount18 = usdcAmount * 1e12;
        uint256 fee18 = (amount18 * tradingFeeBps) / BPS;
        uint256 netAmount18 = amount18 - fee18;

        // Convert virtualBase to USDC terms by multiplying by NAV
        // This way the AMM operates in USDC space, not ratio space
        // Price = NAV * (virtualBase/virtualTokens) = virtualBaseUsdc/virtualTokens
        uint256 virtualBaseUsdc = (effVirtualBase * nav) / PRECISION;

        // Constant product formula in USDC terms
        // tokensOut = virtualTokens * usdcIn / (virtualBaseUsdc + usdcIn)
        uint256 tokensOut = (effVirtualTokens * netAmount18) / (virtualBaseUsdc + netAmount18);
        require(tokensOut > 0, "0T");

        // V39: Slippage protection
        if (minTokensOut > 0) {
            require(tokensOut >= minTokensOut, "Slippage");
        }

        // Check max buy tokens (90% of virtual tokens)
        uint256 maxTokens = getMaxBuyTokens();
        require(tokensOut <= maxTokens, "Max");

        // Update virtual reserves
        // V38: Tiered mode - just update the ratio (virtualBase/virtualTokens)
        // The ratio is applied to tierBcVirtual in getEffectiveVirtual*()
        uint256 newVirtualBaseUsdc = virtualBaseUsdc + netAmount18;
        uint256 newEffVirtualBase = (newVirtualBaseUsdc * PRECISION) / nav;
        uint256 newEffVirtualTokens = effVirtualTokens - tokensOut;

        // In tiered mode, we store the ratio directly
        // effVirtual = tierBcVirtual * virtualBase / virtualTokens
        // So we just need to maintain the ratio proportionally
        virtualBase = newEffVirtualBase;
        virtualTokens = newEffVirtualTokens;

        // V39: Apply max BC ratio cap to prevent price divergence
        // If ratio > maxRatio, adjust virtualTokens to cap the ratio
        uint256 maxRatioBps = IHyperFunFactory(factory).globalMaxBcRatioBps();
        if (maxRatioBps > 0 && virtualTokens > 0) {
            uint256 currentRatio = (virtualBase * BPS) / virtualTokens;
            if (currentRatio > maxRatioBps) {
                // Cap: virtualTokens = virtualBase * BPS / maxRatioBps
                virtualTokens = (virtualBase * BPS) / maxRatioBps;
            }
        }

        // V47: Removed getNAV() here - using entryNav captured before USDC transfer

        _mint(msg.sender, tokensOut);

        // Track purchase timestamp for exit fee calculation
        _updatePurchaseInfo(msg.sender, tokensOut);

        // Track entry NAV for performance fee calculation
        // V47: Use entryNav (captured before USDC entered) for accurate tracking
        _updateEntryRecord(msg.sender, tokensOut, entryNav);

        totalDeposits += netAmount18;
        totalVolume += amount18;  // Track buy volume (before fee)

        // Calculate weighted average entry price for performance fee (legacy, keep for compatibility)
        uint256 oldAmount = depositRecords[msg.sender].depositAmount;
        uint256 oldPrice = depositRecords[msg.sender].depositSharePrice;

        if (oldAmount == 0) {
            depositRecords[msg.sender].depositSharePrice = entryNav;
        } else {
            // Weighted average: (oldAmount * oldPrice + newAmount * newPrice) / totalAmount
            depositRecords[msg.sender].depositSharePrice =
                (oldAmount * oldPrice + netAmount18 * entryNav) / (oldAmount + netAmount18);
        }
        depositRecords[msg.sender].depositAmount += netAmount18;

        // Transfer trading fee to treasury
        uint256 fee6 = fee18 / 1e12;
        if (fee6 > 0) {
            require(IERC20(USDC).transfer(_getTreasury(), fee6), "Tx");
        }

        // Auto-rebalance if needed (handles L1 allocation)
        if (tradingModule != address(0)) {
            IHyperFunTrading(tradingModule).autoRebalance();
        }

        // V40: Update TWAP NAV after trade
        _updateTwapNav();

        // Record actual execution price (USDC paid per token), not post-trade spot price
        uint256 executionPrice = (netAmount18 * PRECISION) / tokensOut;
        emit TokenBought(msg.sender, usdcAmount, tokensOut, executionPrice);
    }

    /// @notice Sell tokens with slippage protection
    /// @param tokens Amount of tokens to sell
    /// @param minUsdcOut Minimum USDC expected (0 = no slippage check)
    function sell(uint256 tokens, uint256 minUsdcOut) external nonReentrant {
        require(tokens > 0, "0T");
        require(balanceOf(msg.sender) >= tokens, "Bal");
        require(pendingSells[msg.sender].usdcAmount == 0, "PS");

        (uint256 tradingFeeBps, , , , , , , ) = _getSettings();

        // Get effective virtual reserves
        uint256 effVirtualBase = getEffectiveVirtualBase();
        uint256 effVirtualTokens = getEffectiveVirtualTokens();
        // V40: Use smoothed NAV for price protection
        uint256 nav = getSmoothedNAV();

        // Calculate Performance Fee tokens to mint to leader
        uint256 performanceFeeTokens = _calculatePerformanceFee(msg.sender, tokens, nav);

        // Convert virtualBase to USDC terms
        uint256 virtualBaseUsdc = (effVirtualBase * nav) / PRECISION;

        // Constant product formula in USDC terms
        // usdcOut = virtualBaseUsdc * tokens / (virtualTokens + tokens)
        uint256 grossAmount18 = (virtualBaseUsdc * tokens) / (effVirtualTokens + tokens);

        // Calculate exit fee based on holding duration
        (uint256 exitFeeBps, uint256 daysHeld) = calculateExitFee(msg.sender);

        // === LIQUIDITY CAP CHECK ===
        // Cap grossAmount based on available liquidity (EVM + L1 Spot)
        uint256 availableLiquidity6 = getAvailableLiquidity();
        uint256 availableLiquidity18 = availableLiquidity6 * 1e12;

        // Calculate max gross amount that can be paid out
        // available = gross - exitFee - tradingFee
        // available = gross - gross*exitFeeBps/BPS - (gross - gross*exitFeeBps/BPS)*tradingFeeBps/BPS
        // available = gross * (1 - exitFeeBps/BPS) * (1 - tradingFeeBps/BPS)
        // gross = available * BPS * BPS / ((BPS - exitFeeBps) * (BPS - tradingFeeBps))
        uint256 maxGross18;
        if (exitFeeBps < BPS && tradingFeeBps < BPS) {
            maxGross18 = (availableLiquidity18 * BPS * BPS) / ((BPS - exitFeeBps) * (BPS - tradingFeeBps));
        } else {
            maxGross18 = 0;
        }

        // Cap grossAmount if it exceeds what's available
        if (grossAmount18 > maxGross18) {
            grossAmount18 = maxGross18;
        }

        uint256 exitFee18 = (grossAmount18 * exitFeeBps) / BPS;
        uint256 afterExitFee18 = grossAmount18 - exitFee18;
        uint256 tradingFee18 = (afterExitFee18 * tradingFeeBps) / BPS;
        uint256 netAmount18 = afterExitFee18 - tradingFee18;

        uint256 netAmount6 = netAmount18 / 1e12;
        uint256 exitFee6 = exitFee18 / 1e12;
        uint256 tradingFee6 = tradingFee18 / 1e12;
        uint256 totalNeeded6 = netAmount6 + tradingFee6;

        // V39: Slippage protection
        if (minUsdcOut > 0) {
            require(netAmount6 >= minUsdcOut, "Slippage");
        }

        // Update virtual reserves
        // V41: Use afterExitFee (net of exit fee) instead of grossAmount
        // This ensures BC price change reflects actual fund outflow, not gross
        // Exit fee effect is captured in NAV increase, not BC ratio decrease
        uint256 newVirtualBaseUsdc = virtualBaseUsdc - afterExitFee18;
        uint256 newEffVirtualBase = (newVirtualBaseUsdc * PRECISION) / nav;
        uint256 newEffVirtualTokens = effVirtualTokens + tokens;

        // In tiered mode, we store the ratio directly
        virtualBase = newEffVirtualBase;
        virtualTokens = newEffVirtualTokens;

        // V39: Apply ratio floor to prevent price < NAV
        // ratio = virtualBase / virtualTokens >= 1.0 (10000 bps)
        if (virtualBase > 0 && virtualTokens > 0) {
            uint256 currentRatio = (virtualBase * BPS) / virtualTokens;
            if (currentRatio < BPS) {
                // Floor: virtualTokens = virtualBase (ratio = 1.0)
                virtualTokens = virtualBase;
            }
        }

        _burn(msg.sender, tokens);

        // Mint Performance Fee tokens to leader
        if (performanceFeeTokens > 0) {
            _mint(leader, performanceFeeTokens);
            emit PerformanceFeeMinted(msg.sender, leader, performanceFeeTokens, nav);
        }

        // Update purchase tracking
        _updatePurchaseInfoAfterSell(msg.sender, tokens);

        // Update entry record for performance fee tracking
        _reduceEntryRecord(msg.sender, tokens);

        // Emit exit fee event
        if (exitFee6 > 0) {
            emit ExitFeeCharged(msg.sender, exitFee6, exitFeeBps, daysHeld);
        }

        uint256 evmUsdcBalance = IERC20(USDC).balanceOf(address(this));

        // Exit fee stays in vault (increases NAV for remaining holders)

        uint256 executionPrice = (grossAmount18 * PRECISION) / tokens;
        totalVolume += grossAmount18;

        bool createdPendingSell = false;

        if (evmUsdcBalance >= totalNeeded6) {
            if (tradingFee6 > 0) {
                require(IERC20(USDC).transfer(_getTreasury(), tradingFee6), "Tx");
            }
            // exitFee6 stays in vault - not transferred
            require(IERC20(USDC).transfer(msg.sender, netAmount6), "Tx");
            emit TokenSold(msg.sender, tokens, netAmount6, executionPrice);
        } else {
            uint256 l1Spot6 = getL1SpotBalance();
            require(evmUsdcBalance + l1Spot6 >= totalNeeded6, "LR");

            uint256 shortfall6 = totalNeeded6 - evmUsdcBalance;
            // V42: Add 0.5% buffer to shortfall to account for L1 precision loss
            // L1 Spot balance is in 8 decimals, divided by 100 for 6 decimals (rounds down)
            // This can cause a small gap between calculated and actual transfer amount
            uint256 shortfallWithBuffer6 = (shortfall6 * 1005) / 1000;
            // Cap at available L1 Spot balance
            if (shortfallWithBuffer6 > l1Spot6) {
                shortfallWithBuffer6 = l1Spot6;
            }
            uint64 shortfall8 = uint64(shortfallWithBuffer6 * 100);

            bytes memory action = abi.encodePacked(
                uint8(1),
                ACTION_SPOT_SEND,
                abi.encode(USDC_L1_SYSTEM, uint64(0), shortfall8)
            );
            CORE_WRITER.sendRawAction(action);

            pendingSells[msg.sender] = PSSell({
                usdcAmount: netAmount6,
                feeAmount: tradingFee6,  // V44: exitFee stays in vault, not transferred
                timestamp: block.timestamp
            });
            // V44: Only include netAmount + tradingFee (exitFee stays in vault)
            totalPSUsdc += netAmount6 + tradingFee6;
            createdPendingSell = true;

            emit SellPS(msg.sender, netAmount6, tradingFee6);
            emit TokenSold(msg.sender, tokens, netAmount6, executionPrice);
        }

        // V40: Update TWAP NAV after trade
        _updateTwapNav();

        // V42: Only auto-rebalance when there's NO pending sell
        // When PS is created, L1 SPOT_SEND was already triggered and L1 balance is stale
        // Calling autoRebalance would read wrong balance and potentially double-transfer
        if (!createdPendingSell && tradingModule != address(0)) {
            IHyperFunTrading(tradingModule).autoRebalance();
        }
    }

    function claimSell() external nonReentrant {
        PSSell memory pending = pendingSells[msg.sender];
        require(pending.usdcAmount > 0, "NP");

        uint256 totalNeeded = pending.usdcAmount + pending.feeAmount;
        uint256 evmBalance = IERC20(USDC).balanceOf(address(this));
        require(evmBalance >= totalNeeded, "Retry");

        delete pendingSells[msg.sender];
        totalPSUsdc -= totalNeeded;

        if (pending.feeAmount > 0) {
            require(IERC20(USDC).transfer(_getTreasury(), pending.feeAmount), "Tx");
        }
        require(IERC20(USDC).transfer(msg.sender, pending.usdcAmount), "Tx");

        emit SellClaimed(msg.sender, pending.usdcAmount);
    }

    // ============ Leader Deposit Function ============
    // Note: redeem() removed in V42 - Leader must use sell() like regular users

    function deposit(uint256 usdcAmount) external whenNotPaused nonReentrant {
        (, , , uint256 minDepositUsdc, , , , ) = _getSettings();
        require(msg.sender == leader, "!Leader");
        require(usdcAmount >= minDepositUsdc, "Min");

        // V40: Use smoothed NAV for price protection
        uint256 nav = getSmoothedNAV();

        // V47: Entry NAV should match the NAV used for share calculation (Smoothed NAV)
        uint256 entryNav = nav;

        require(IERC20(USDC).transferFrom(msg.sender, address(this), usdcAmount), "Tx");

        uint256 amount18 = usdcAmount * 1e12;
        uint256 shares = (amount18 * PRECISION) / nav;
        require(shares > 0, "0S");

        // Track purchase for exit fee calculation (leader also subject to exit fees on sell)
        _updatePurchaseInfo(msg.sender, shares);

        // Track entry NAV for performance fee calculation
        // V47: Use entryNav (captured before USDC entered)
        _updateEntryRecord(msg.sender, shares, entryNav);

        totalDeposits += amount18;

        _mint(msg.sender, shares);

        // Auto-rebalance will handle L1 allocation
        if (tradingModule != address(0)) {
            IHyperFunTrading(tradingModule).autoRebalance();
        }

        emit Deposited(msg.sender, usdcAmount, shares);
    }

    // ============ View Functions ============

    function getL1AccountValue() public view returns (uint256) {
        if (tradingModule == address(0)) return 0;
        return IHyperFunTrading(tradingModule).getL1AccountValue();
    }

    function getL1SpotBalance() public view returns (uint256) {
        (bool success, bytes memory data) = PRECOMPILE_SPOT.staticcall(abi.encode(address(this), uint64(0)));
        if (success && data.length >= 32) {
            (uint256 total, , ) = abi.decode(data, (uint256, uint256, uint256));
            return total / 100;
        }
        return 0;
    }

    function getTotalAssets() public view returns (uint256) {
        // Both L1 values read from precompile in real-time
        uint256 l1SpotValue = getL1SpotBalance() * 1e12;
        uint256 l1PerpValue = getL1AccountValue() * 1e12;
        uint256 evmUsdcBalance = IERC20(USDC).balanceOf(address(this)) * 1e12;
        uint256 pendingOut = totalPSUsdc * 1e12;
        uint256 total = l1PerpValue + l1SpotValue + evmUsdcBalance;
        return total > pendingOut ? total - pendingOut : 0;
    }

    // View functions removed to reduce contract size - use public state variables directly

    // ============ Admin Functions ============

    /// @notice Approve a builder to receive trading fee rebates
    /// @param builder The builder address to approve
    /// @param maxFeeRate Maximum fee rate in decibps (10 = 0.01%, 50 = 0.05%)
    /// @dev Can be called by admin or factory owner (for platform-level builder settings)
    function approveBuilderFee(address builder, uint64 maxFeeRate) external {
        require(
            msg.sender == admin ||
            msg.sender == factory ||
            (factory != address(0) && msg.sender == IHyperFunFactory(factory).owner()),
            "!Auth"
        );
        require(builder != address(0), "!Builder");
        bytes memory action = abi.encodePacked(
            uint8(1),
            ACTION_APPROVE_BUILDER_FEE,
            abi.encode(maxFeeRate, builder)
        );
        CORE_WRITER.sendRawAction(action);
        emit BuilderFeeApproved(builder, maxFeeRate);
    }

    // ============ Factory Owner Functions ============
    // Trading fee, price limits, reserve ratio, min deposit, rebalance thresholds
    // are now controlled globally via Factory.setGlobal*() functions

    function setPaused(bool _paused) external onlyFactoryOwner {
        paused = _paused;
    }

    function setAdmin(address _admin) external onlyFactoryOwner {
        require(_admin != address(0), "!A");
        address oldAdmin = admin;
        admin = _admin;
        emit AdminChanged(oldAdmin, _admin);
    }

    // setTreasury removed - now read from Factory.treasury()

    function setTradingModule(address _tradingModule) external onlyFactoryOwner {
        address oldModule = tradingModule;
        tradingModule = _tradingModule;
        emit TradingModuleChanged(oldModule, _tradingModule);
    }

    // resetBondingCurve removed - prevents price manipulation
    // setMaxBuyBps removed - now in Factory
    // setTotalPSUsdc removed - too dangerous
    // setInitialAssets removed - V38 uses tiered mode only

    /// @notice Trigger auto-rebalance (called by Trading module after trades)
    function triggerRebalance() external onlyTradingModule {
        if (tradingModule != address(0)) {
            IHyperFunTrading(tradingModule).autoRebalance();
        }
    }

    /// @notice Deposit USDC to L1 (called by Trading module for rebalance)
    function depositToL1(uint256 amount) external onlyTradingModule {
        IERC20(USDC).approve(CORE_DEPOSIT_WALLET, amount);
        ICoreDepositWallet(CORE_DEPOSIT_WALLET).deposit(amount, type(uint32).max);
    }

    /// @notice V38: Initialize L1 account (called by Factory during vault creation)
    /// @dev This deposits 1 USDC to L1 to pay the account initialization fee
    /// @param amount The amount of USDC to deposit (typically 1 USDC = 1000000)
    function initializeL1(uint256 amount) external {
        require(msg.sender == factory, "!Factory");
        require(amount > 0, "!Amount");
        // Transfer USDC from Factory to this vault
        require(IERC20(USDC).transferFrom(factory, address(this), amount), "TxF");
        // Deposit to L1
        IERC20(USDC).approve(CORE_DEPOSIT_WALLET, amount);
        ICoreDepositWallet(CORE_DEPOSIT_WALLET).deposit(amount, type(uint32).max);
        emit DepositedToL1(amount);
    }

    // Exit fee functions removed - now controlled by Factory
    // setExitFeeEnabled, setExitFeeRecipient, setExitFeeTiers, setNavVirtual
    // Exit fees always stay in vault (address(0)) for decentralization

    /// @notice Execute L1 action (called by Trading module)
    function executeL1Action(bytes calldata action) external onlyTradingModule {
        CORE_WRITER.sendRawAction(action);
    }

    // ============ Metadata Functions ============

    /// @notice Set metadata URI (IPFS or URL pointing to JSON with image, description, etc.)
    /// @dev Only the vault leader can update metadata
    /// @param _metadataURI URI pointing to metadata JSON (e.g., "ipfs://Qm..." or "https://...")
    function setMetadataURI(string calldata _metadataURI) external onlyLeader {
        metadataURI = _metadataURI;
        emit MetadataUpdated(_metadataURI);
    }

    // ============ Emergency Functions (Factory Owner Only - Testing) ============

    /// @notice Withdraw L1 Spot to EVM (emergency)
    function emergencyWithdrawL1SpotToEVM(uint256 amount6) external onlyFactoryOwner {
        uint64 amount8 = uint64(amount6 * 100);
        bytes memory action = abi.encodePacked(
            uint8(1), ACTION_SPOT_SEND, abi.encode(USDC_L1_SYSTEM, uint64(0), amount8)
        );
        CORE_WRITER.sendRawAction(action);
        emit WithdrawnFromL1(amount6);
    }

    /// @notice Emergency withdraw EVM USDC to treasury
    function emergencyWithdrawEVM(uint256 amount6) external onlyFactoryOwner {
        require(IERC20(USDC).transfer(_getTreasury(), amount6), "Tx");
    }
}
