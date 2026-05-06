// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IHyperFunToken {
    function initialize(
        address _leader,
        string calldata _name,
        string calldata _symbol,
        uint256 _feeBps,
        address _treasury,
        address _admin,
        address _tradingModule,
        address _factory,
        uint256 _virtualBase,
        uint256 _virtualTokens,
        uint256 _initialAssets
    ) external;
    function setAdmin(address _admin) external;
    function approveBuilderFee(address builder, uint64 maxFeeRate) external;
    function leader() external view returns (address);
    function emergencyWithdrawL1SpotToEVM(uint256 amount6) external;
    function emergencyWithdrawEVM(uint256 amount6) external;
    function initializeL1(uint256 amount) external;  // V38: L1 account initialization
}

interface IHyperFunTrading {
    function initialize(address _vaultCore, address _admin, address _factory) external;
}

/// @title HyperFunFactory
/// @notice UUPS Upgradeable Factory for deploying HyperFun Vaults
/// @dev Deploys minimal proxies for HyperFunToken + HyperFunTrading
contract HyperFunFactory is Initializable, UUPSUpgradeable, OwnableUpgradeable {

    // ============ Constants ============
    uint256 public constant MAX_PERFORMANCE_FEE = 3000;  // 30%
    uint256 public constant MAX_EXIT_FEE = 5000;         // 50%

    // ============ State Variables ============

    // Implementation contracts (upgradeable by admin)
    address public coreImplementation;
    address public tradingImplementation;

    // Platform settings
    address public treasury;
    uint256 public creationFee;           // USDC fee to create vault (0 = free)
    address public usdc;

    // Default parameters for new vaults (passed to Core.initialize)
    uint256 public defaultBcVirtualBase;    // Default BC virtual base (2M)
    uint256 public defaultBcVirtualTokens;  // Default BC virtual tokens (2M)
    uint256 public defaultInitialAssets;    // Default initial assets baseline (1K)

    // Builder fee settings (for L1 trading rebates)
    address public defaultBuilder;          // Default builder address for new vaults
    uint64 public defaultBuilderFeeRate;    // Default fee rate in decibps (50 = 0.05%)

    // ============ Global Vault Settings (read by all vaults) ============
    uint256 public globalTradingFeeBps;     // Trading fee (default 100 = 1%)
    uint256 public globalMaxPremiumBps;     // Max premium (default 10000 = 100%)
    uint256 public globalMaxDiscountBps;    // Max discount (default 5000 = 50%)
    uint256 public globalMinDepositUsdc;    // Min deposit (default 5 USDC)
    uint256 public globalRebalanceLowBps;   // Rebalance low threshold (default 4800 = 48%)
    uint256 public globalRebalanceHighBps;  // Rebalance high threshold (default 5200 = 52%)
    uint256 public globalReserveRatioBps;   // Reserve ratio (default 5000 = 50%)
    uint256 public globalMinReserveRatioBps; // Min reserve ratio (default 3000 = 30%)
    uint256 public globalMaxBuyBps;         // Max buy per tx (default 100 = 1%)
    uint256 public globalNavVirtualAssets;  // NAV virtual assets for stability (unified)
    uint256 public globalNavVirtualShares;  // NAV virtual shares for stability (unified)
    bool public globalExitFeeEnabled;       // Exit fee enabled (default true)

    // Global exit fee tiers (all vaults use the same tiers)
    struct ExitFeeTier {
        uint256 daysHeld;
        uint256 feeBps;
    }
    ExitFeeTier[] public globalExitFeeTiers;

    // Vault registry
    address[] public allVaults;
    mapping(address => address[]) public vaultsByLeader;
    mapping(address => bool) public isVault;
    mapping(address => bool) public isVerified;  // Admin-verified vaults

    // Vault info
    struct VaultInfo {
        address core;
        address trading;
        address leader;
        string name;
        string symbol;
        uint256 performanceFeeBps;
        uint256 createdAt;
        bool verified;
    }
    mapping(address => VaultInfo) public vaultInfo;

    // Pause
    bool public paused;

    // V34: New variable added at end to preserve storage layout
    uint256 public globalBcVirtualMinimumBps; // BC Virtual minimum floor (default 500 = 5%)

    // V35: Dynamic NAV Virtual
    uint256 public globalNavVirtualMode;           // 0 = fixed, 1 = dynamic, 2 = auto-dynamic
    uint256 public globalNavVirtualMultiplierBps;  // Multiplier in bps (used as minMul in mode 2)
    uint256 public globalNavVirtualMinimum;        // Minimum NAV Virtual value

    // V36: Auto-Dynamic NAV Virtual (mode 2)
    uint256 public globalNavVirtualMaxMultiplierBps;  // Max multiplier in bps (15000 = 1.5x)
    uint256 public globalNavVirtualTargetAssets;      // Target assets for max multiplier

    // V37: Graduation Tier System
    // Each tier defines BC Virtual and NAV Virtual parameters for different vault sizes
    // V38: Added squaredRatioBps for progressive squared effect decay
    struct GraduationTier {
        uint256 threshold;       // Asset threshold to enter this tier (in 18 decimals)
        uint256 bcVirtual;       // BC Virtual pool size for this tier (in 18 decimals)
        uint256 navMinMulBps;    // NAV Virtual min multiplier in bps (2000 = 0.2x)
        uint256 navMaxMulBps;    // NAV Virtual max multiplier in bps (5000 = 0.5x)
        uint256 squaredRatioBps; // Squared effect weight in bps (10000=100% squared, 0=linear)
    }
    GraduationTier[] public graduationTiers;
    bool public graduationTieredMode;  // true = use graduation tiers, false = simple mode

    // V39: Max BC Ratio - limits vBase/vTokens ratio to prevent price divergence
    // 18000 = 1.8x, 25000 = 2.5x, 0 = disabled
    uint256 public globalMaxBcRatioBps;

    // ============ Events ============

    event VaultCreated(
        address indexed leader,
        address indexed core,
        address indexed trading,
        string name,
        string symbol,
        uint256 performanceFeeBps
    );
    event ImplementationUpdated(address newCore, address newTrading);
    event VaultVerified(address indexed vault, bool verified);
    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);
    event DefaultsUpdated(uint256 bcVirtualBase, uint256 bcVirtualTokens, uint256 initialAssets);

    // ============ Initializer (replaces constructor) ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _coreImpl,
        address _tradingImpl,
        address _treasury,
        address _usdc
    ) public initializer {
        require(_coreImpl != address(0), "!Core");
        require(_tradingImpl != address(0), "!Trading");
        require(_treasury != address(0), "!Treasury");
        require(_usdc != address(0), "!USDC");

        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();

        coreImplementation = _coreImpl;
        tradingImplementation = _tradingImpl;
        treasury = _treasury;
        usdc = _usdc;

        creationFee = 0;  // Free initially

        // Default BC parameters (passed to Core.initialize)
        defaultBcVirtualBase = 2_000_000 * 1e18;
        defaultBcVirtualTokens = 2_000_000 * 1e18;
        defaultInitialAssets = 100_000 * 1e18;  // 100K baseline for BC scaling

        // Global vault settings
        globalTradingFeeBps = 100;          // 1%
        globalMaxPremiumBps = 10000;        // 100%
        globalMaxDiscountBps = 5000;        // 50%
        globalMinDepositUsdc = 5 * 1e6;     // 5 USDC
        globalRebalanceLowBps = 4800;       // 48%
        globalRebalanceHighBps = 5200;      // 52%
        globalReserveRatioBps = 5000;       // 50%
        globalMinReserveRatioBps = 3000;    // 30%
        globalMaxBuyBps = 100;              // 1% max buy per tx
        globalNavVirtualAssets = 500_000 * 1e18;  // 500K virtual assets
        globalNavVirtualShares = 500_000 * 1e18;  // 500K virtual shares
        globalExitFeeEnabled = true;
        globalBcVirtualMinimumBps = 500;        // 5% minimum BC Virtual floor

        // V35: Dynamic NAV Virtual defaults
        globalNavVirtualMode = 0;                       // Fixed mode by default
        globalNavVirtualMultiplierBps = 15000;          // 1.5x multiplier
        globalNavVirtualMinimum = 1000 * 1e18;          // Minimum 1000

        // Default exit fee tiers
        globalExitFeeTiers.push(ExitFeeTier({daysHeld: 0, feeBps: 1500}));   // <7d: 15%
        globalExitFeeTiers.push(ExitFeeTier({daysHeld: 7, feeBps: 800}));    // 7-30d: 8%
        globalExitFeeTiers.push(ExitFeeTier({daysHeld: 30, feeBps: 300}));   // 30-90d: 3%
        globalExitFeeTiers.push(ExitFeeTier({daysHeld: 90, feeBps: 0}));     // >90d: 0%
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ============ Create Vault (Simple) ============

    /// @notice Create a vault with default settings
    function createVault(
        string calldata _name,
        string calldata _symbol,
        uint256 _performanceFeeBps
    ) external returns (address core, address trading) {
        return _createVaultInternal(_name, _symbol, _performanceFeeBps, 0, 0, 0);
    }

    // ============ Create Vault (Custom BC Params) ============

    /// @notice Create a vault with custom BC parameters (Owner only)
    /// @dev Only factory owner can create vaults with custom BC params
    function createVaultAdvanced(
        string calldata _name,
        string calldata _symbol,
        uint256 _performanceFeeBps,
        uint256 _bcVirtualBase,
        uint256 _bcVirtualTokens,
        uint256 _initialAssets
    ) external onlyOwner returns (address core, address trading) {
        return _createVaultInternal(
            _name, _symbol, _performanceFeeBps,
            _bcVirtualBase, _bcVirtualTokens, _initialAssets
        );
    }

    // ============ Internal Create ============

    // V38: L1 initialization fee (1 USDC)
    uint256 public constant L1_INIT_FEE = 1000000; // 1 USDC (6 decimals)

    function _createVaultInternal(
        string memory _name,
        string memory _symbol,
        uint256 _performanceFeeBps,
        uint256 _bcVirtualBase,
        uint256 _bcVirtualTokens,
        uint256 _initialAssets
    ) internal returns (address core, address trading) {
        require(!paused, "Paused");
        require(bytes(_name).length > 0, "Empty name");
        require(bytes(_symbol).length > 0, "Empty symbol");
        require(_performanceFeeBps <= MAX_PERFORMANCE_FEE, "Fee too high");

        // Collect creation fee if set
        if (creationFee > 0) {
            require(
                IERC20(usdc).transferFrom(msg.sender, treasury, creationFee),
                "Fee transfer failed"
            );
        }

        // V38: Collect L1 initialization fee (1 USDC) from leader
        require(
            IERC20(usdc).transferFrom(msg.sender, address(this), L1_INIT_FEE),
            "L1 init fee transfer failed"
        );

        // Use defaults if 0
        uint256 virtualBase = _bcVirtualBase > 0 ? _bcVirtualBase : defaultBcVirtualBase;
        uint256 virtualTokens = _bcVirtualTokens > 0 ? _bcVirtualTokens : defaultBcVirtualTokens;
        uint256 initialAssets = _initialAssets > 0 ? _initialAssets : defaultInitialAssets;

        // 1. Deploy Trading Proxy first (we need its address for Core init)
        trading = address(new ERC1967Proxy(tradingImplementation, ""));

        // 2. Deploy Core Proxy
        core = address(new ERC1967Proxy(coreImplementation, ""));

        // 3. Initialize Trading (Factory as initial admin, will transfer later)
        IHyperFunTrading(trading).initialize(core, address(this), address(this));

        // 4. Initialize Core with BC parameters
        IHyperFunToken(core).initialize(
            msg.sender,              // leader
            _name,
            _symbol,
            _performanceFeeBps,
            treasury,                // protocol treasury
            address(this),           // admin = Factory (temporary)
            trading,                 // trading module
            address(this),           // factory - only factory owner can upgrade
            virtualBase,             // BC virtual base
            virtualTokens,           // BC virtual tokens
            initialAssets            // Initial assets baseline
        );

        // 5. Approve builder fee if configured
        if (defaultBuilder != address(0) && defaultBuilderFeeRate > 0) {
            IHyperFunToken(core).approveBuilderFee(defaultBuilder, defaultBuilderFeeRate);
        }

        // 6. Admin stays with Factory Owner (NOT transferred to vault creator)
        IHyperFunToken(core).setAdmin(owner());

        // 7. V38: Initialize L1 account (deposit 1 USDC to cover Hyperliquid account init fee)
        IERC20(usdc).approve(core, L1_INIT_FEE);
        IHyperFunToken(core).initializeL1(L1_INIT_FEE);

        // 8. Register vault
        allVaults.push(core);
        vaultsByLeader[msg.sender].push(core);
        isVault[core] = true;

        vaultInfo[core] = VaultInfo({
            core: core,
            trading: trading,
            leader: msg.sender,
            name: _name,
            symbol: _symbol,
            performanceFeeBps: _performanceFeeBps,
            createdAt: block.timestamp,
            verified: false
        });

        emit VaultCreated(
            msg.sender,
            core,
            trading,
            _name,
            _symbol,
            _performanceFeeBps
        );

        return (core, trading);
    }

    // ============ View Functions ============

    function totalVaults() external view returns (uint256) {
        return allVaults.length;
    }

    function getVaults(uint256 offset, uint256 limit) external view returns (address[] memory) {
        uint256 total = allVaults.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit;
        if (end > total) end = total;
        address[] memory result = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = allVaults[i];
        }
        return result;
    }

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }

    function getVaultsByLeader(address leader) external view returns (address[] memory) {
        return vaultsByLeader[leader];
    }

    function getVaultCountByLeader(address leader) external view returns (uint256) {
        return vaultsByLeader[leader].length;
    }

    function getVaultInfo(address vault) external view returns (VaultInfo memory) {
        return vaultInfo[vault];
    }

    function getVerifiedVaults() external view returns (address[] memory) {
        uint256 count = 0;
        for (uint i = 0; i < allVaults.length; i++) {
            if (isVerified[allVaults[i]]) count++;
        }
        address[] memory result = new address[](count);
        uint256 idx = 0;
        for (uint i = 0; i < allVaults.length; i++) {
            if (isVerified[allVaults[i]]) {
                result[idx++] = allVaults[i];
            }
        }
        return result;
    }

    // ============ Admin Functions ============

    function setImplementations(address _core, address _trading) external onlyOwner {
        require(_core != address(0) && _trading != address(0), "Zero address");
        coreImplementation = _core;
        tradingImplementation = _trading;
        emit ImplementationUpdated(_core, _trading);
    }

    function setCreationFee(uint256 _fee) external onlyOwner {
        uint256 oldFee = creationFee;
        creationFee = _fee;
        emit CreationFeeUpdated(oldFee, _fee);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "Zero address");
        treasury = _treasury;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    /// @notice Set default BC parameters for new vaults
    function setDefaults(
        uint256 _bcVirtualBase,
        uint256 _bcVirtualTokens,
        uint256 _initialAssets
    ) external onlyOwner {
        defaultBcVirtualBase = _bcVirtualBase;
        defaultBcVirtualTokens = _bcVirtualTokens;
        defaultInitialAssets = _initialAssets;
        emit DefaultsUpdated(_bcVirtualBase, _bcVirtualTokens, _initialAssets);
    }

    function setDefaultBuilder(address _builder, uint64 _feeRate) external onlyOwner {
        defaultBuilder = _builder;
        defaultBuilderFeeRate = _feeRate;
    }

    function approveBuilderFeeForVault(address vault, address builder, uint64 feeRate) external onlyOwner {
        require(isVault[vault], "Not a vault");
        IHyperFunToken(vault).approveBuilderFee(builder, feeRate);
    }

    function batchApproveBuilderFee(address[] calldata vaults, address builder, uint64 feeRate) external onlyOwner {
        for (uint i = 0; i < vaults.length; i++) {
            if (isVault[vaults[i]]) {
                IHyperFunToken(vaults[i]).approveBuilderFee(builder, feeRate);
            }
        }
    }

    function setVaultVerified(address vault, bool verified) external onlyOwner {
        require(isVault[vault], "Not a vault");
        isVerified[vault] = verified;
        vaultInfo[vault].verified = verified;
        emit VaultVerified(vault, verified);
    }

    function batchSetVaultVerified(address[] calldata vaults, bool verified) external onlyOwner {
        for (uint i = 0; i < vaults.length; i++) {
            if (isVault[vaults[i]]) {
                isVerified[vaults[i]] = verified;
                vaultInfo[vaults[i]].verified = verified;
                emit VaultVerified(vaults[i], verified);
            }
        }
    }

    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(msg.sender, amount);
    }

    // ============ Emergency Vault Functions ============

    function emergencyWithdrawL1SpotToEVM(address vault, uint256 amount6) external onlyOwner {
        require(isVault[vault], "Not a vault");
        IHyperFunToken(vault).emergencyWithdrawL1SpotToEVM(amount6);
    }

    function emergencyWithdrawEVM(address vault, uint256 amount6) external onlyOwner {
        require(isVault[vault], "Not a vault");
        IHyperFunToken(vault).emergencyWithdrawEVM(amount6);
    }

    // ============ Global Vault Settings Functions ============

    function setGlobalTradingFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 500, "Max 5%");
        globalTradingFeeBps = _feeBps;
    }

    function setGlobalPriceLimits(uint256 _maxPremiumBps, uint256 _maxDiscountBps) external onlyOwner {
        require(_maxPremiumBps <= 10000, "Max 100%");
        require(_maxDiscountBps <= 5000, "Max 50%");
        globalMaxPremiumBps = _maxPremiumBps;
        globalMaxDiscountBps = _maxDiscountBps;
    }

    function setGlobalMinDeposit(uint256 _minUsdc) external onlyOwner {
        globalMinDepositUsdc = _minUsdc;
    }

    function setGlobalRebalanceThresholds(uint256 _lowBps, uint256 _highBps) external onlyOwner {
        require(_lowBps < globalReserveRatioBps, "Low < reserve");
        require(_highBps > globalReserveRatioBps, "High > reserve");
        require(_highBps <= 10000, "Max 100%");
        globalRebalanceLowBps = _lowBps;
        globalRebalanceHighBps = _highBps;
    }

    function setGlobalReserveRatio(uint256 _ratioBps, uint256 _minRatioBps) external onlyOwner {
        require(_ratioBps <= 10000, "Max 100%");
        require(_minRatioBps < _ratioBps, "Min < ratio");
        globalReserveRatioBps = _ratioBps;
        globalMinReserveRatioBps = _minRatioBps;
    }

    function getGlobalSettings() external view returns (
        uint256 tradingFeeBps,
        uint256 maxPremiumBps,
        uint256 maxDiscountBps,
        uint256 minDepositUsdc,
        uint256 rebalanceLowBps,
        uint256 rebalanceHighBps,
        uint256 reserveRatioBps,
        uint256 minReserveRatioBps
    ) {
        return (
            globalTradingFeeBps,
            globalMaxPremiumBps,
            globalMaxDiscountBps,
            globalMinDepositUsdc,
            globalRebalanceLowBps,
            globalRebalanceHighBps,
            globalReserveRatioBps,
            globalMinReserveRatioBps
        );
    }

    function getGlobalSettingsExt() external view returns (
        uint256 maxBuyBps,
        uint256 navVirtualAssets,
        uint256 navVirtualShares,
        bool exitFeeEnabled
    ) {
        return (
            globalMaxBuyBps,
            globalNavVirtualAssets,
            globalNavVirtualShares,
            globalExitFeeEnabled
        );
    }

    function getGlobalExitFeeTiers() external view returns (ExitFeeTier[] memory) {
        return globalExitFeeTiers;
    }

    function setGlobalMaxBuyBps(uint256 _maxBuyBps) external onlyOwner {
        require(_maxBuyBps >= 10 && _maxBuyBps <= 1000, "0.1-10%");
        globalMaxBuyBps = _maxBuyBps;
    }

    function setGlobalBcVirtualMinimum(uint256 _minimumBps) external onlyOwner {
        require(_minimumBps >= 100 && _minimumBps <= 5000, "1-50%");
        globalBcVirtualMinimumBps = _minimumBps;
    }

    /// @notice Set max BC ratio (vBase/vTokens) to prevent price divergence
    /// @param _ratioBps Max ratio in bps (18000 = 1.8x, 0 = disabled)
    function setGlobalMaxBcRatio(uint256 _ratioBps) external onlyOwner {
        require(_ratioBps == 0 || (_ratioBps >= 10000 && _ratioBps <= 50000), "0 or 1-5x");
        globalMaxBcRatioBps = _ratioBps;
    }

    /// @notice Get max BC ratio setting
    function getGlobalMaxBcRatio() external view returns (uint256) {
        return globalMaxBcRatioBps;
    }

    function setGlobalNavVirtual(uint256 _assets, uint256 _shares) external onlyOwner {
        globalNavVirtualAssets = _assets;
        globalNavVirtualShares = _shares;
    }

    function setGlobalExitFeeEnabled(bool _enabled) external onlyOwner {
        globalExitFeeEnabled = _enabled;
    }

    function setGlobalExitFeeTiers(uint256[] calldata _daysHeld, uint256[] calldata _feeBps) external onlyOwner {
        require(_daysHeld.length == _feeBps.length, "Length");
        require(_daysHeld.length > 0 && _daysHeld.length <= 10, "Tiers");

        delete globalExitFeeTiers;

        uint256 lastDays = 0;
        for (uint256 i = 0; i < _daysHeld.length; i++) {
            require(i == 0 || _daysHeld[i] > lastDays, "Asc");
            require(_feeBps[i] <= MAX_EXIT_FEE, "Max 50%");
            globalExitFeeTiers.push(ExitFeeTier({
                daysHeld: _daysHeld[i],
                feeBps: _feeBps[i]
            }));
            lastDays = _daysHeld[i];
        }
    }

    /// @notice Get default BC parameters
    function getDefaultBcParams() external view returns (
        uint256 bcVirtualBase,
        uint256 bcVirtualTokens,
        uint256 initialAssets
    ) {
        return (defaultBcVirtualBase, defaultBcVirtualTokens, defaultInitialAssets);
    }

    // ============ V35: Dynamic NAV Virtual Functions ============

    /// @notice Set dynamic NAV virtual parameters (mode 0 or 1)
    /// @param _mode 0 = fixed, 1 = dynamic, 2 = auto-dynamic
    /// @param _multiplierBps Multiplier in bps (min multiplier for mode 2)
    /// @param _minimum Minimum NAV Virtual value
    function setGlobalNavVirtualDynamic(
        uint256 _mode,
        uint256 _multiplierBps,
        uint256 _minimum
    ) external onlyOwner {
        require(_mode <= 2, "Mode 0-2");
        require(_multiplierBps >= 100 && _multiplierBps <= 100000, "0.01x-10x");
        globalNavVirtualMode = _mode;
        globalNavVirtualMultiplierBps = _multiplierBps;
        globalNavVirtualMinimum = _minimum;
    }

    /// @notice Set auto-dynamic parameters (mode 2)
    /// @param _minMultiplierBps Min multiplier (e.g., 3500 = 0.35x) - early stage
    /// @param _maxMultiplierBps Max multiplier (e.g., 15000 = 1.5x) - mature stage
    /// @param _targetAssets Target assets to reach max multiplier (e.g., 1000000 * 1e18)
    /// @param _minimum Minimum NAV Virtual value
    function setGlobalNavVirtualAutoDynamic(
        uint256 _minMultiplierBps,
        uint256 _maxMultiplierBps,
        uint256 _targetAssets,
        uint256 _minimum
    ) external onlyOwner {
        require(_minMultiplierBps >= 100 && _minMultiplierBps <= 50000, "0.01x-5x");
        require(_maxMultiplierBps >= _minMultiplierBps && _maxMultiplierBps <= 100000, "max >= min, <= 10x");
        require(_targetAssets > 0, "Target > 0");
        globalNavVirtualMode = 2;  // Auto-dynamic mode
        globalNavVirtualMultiplierBps = _minMultiplierBps;
        globalNavVirtualMaxMultiplierBps = _maxMultiplierBps;
        globalNavVirtualTargetAssets = _targetAssets;
        globalNavVirtualMinimum = _minimum;
    }

    /// @notice Get dynamic NAV virtual parameters
    function getGlobalNavVirtualDynamic() external view returns (
        uint256 mode,
        uint256 multiplierBps,
        uint256 minimum
    ) {
        return (globalNavVirtualMode, globalNavVirtualMultiplierBps, globalNavVirtualMinimum);
    }

    /// @notice Get all NAV virtual parameters including auto-dynamic
    function getGlobalNavVirtualParams() external view returns (
        uint256 mode,
        uint256 minMultiplierBps,
        uint256 maxMultiplierBps,
        uint256 targetAssets,
        uint256 minimum
    ) {
        return (
            globalNavVirtualMode,
            globalNavVirtualMultiplierBps,
            globalNavVirtualMaxMultiplierBps,
            globalNavVirtualTargetAssets,
            globalNavVirtualMinimum
        );
    }

    // ============ V37: Graduation Tier Functions ============
    // V38: Added squaredRatioBps for progressive squared effect decay

    /// @notice Set graduation tiers for tiered BC/NAV Virtual system
    /// @param _thresholds Asset thresholds for each tier (ascending order, 18 decimals)
    /// @param _bcVirtuals BC Virtual pool sizes for each tier (18 decimals)
    /// @param _navMinMuls NAV Virtual min multipliers in bps (2000 = 0.2x)
    /// @param _navMaxMuls NAV Virtual max multipliers in bps (5000 = 0.5x)
    /// @param _squaredRatios Squared effect weights in bps (10000=100%, 8000=80%, 0=linear)
    function setGraduationTiers(
        uint256[] calldata _thresholds,
        uint256[] calldata _bcVirtuals,
        uint256[] calldata _navMinMuls,
        uint256[] calldata _navMaxMuls,
        uint256[] calldata _squaredRatios
    ) external onlyOwner {
        require(_thresholds.length == _bcVirtuals.length, "Length mismatch");
        require(_thresholds.length == _navMinMuls.length, "Length mismatch");
        require(_thresholds.length == _navMaxMuls.length, "Length mismatch");
        require(_thresholds.length == _squaredRatios.length, "Length mismatch");
        require(_thresholds.length > 0 && _thresholds.length <= 10, "1-10 tiers");

        delete graduationTiers;

        uint256 lastThreshold = 0;
        for (uint256 i = 0; i < _thresholds.length; i++) {
            require(_thresholds[i] > lastThreshold, "Thresholds must be ascending");
            require(_bcVirtuals[i] > 0, "BC Virtual > 0");
            require(_navMinMuls[i] <= _navMaxMuls[i], "Min <= Max");
            require(_navMaxMuls[i] <= 100000, "Max multiplier <= 10x");
            require(_squaredRatios[i] <= 10000, "Squared ratio <= 100%");

            graduationTiers.push(GraduationTier({
                threshold: _thresholds[i],
                bcVirtual: _bcVirtuals[i],
                navMinMulBps: _navMinMuls[i],
                navMaxMulBps: _navMaxMuls[i],
                squaredRatioBps: _squaredRatios[i]
            }));
            lastThreshold = _thresholds[i];
        }
    }

    /// @notice Enable or disable graduation tiered mode
    /// @param _tiered true = use graduation tiers, false = simple mode
    function setGraduationMode(bool _tiered) external onlyOwner {
        graduationTieredMode = _tiered;
    }

    /// @notice Get all graduation tiers
    function getGraduationTiers() external view returns (GraduationTier[] memory) {
        return graduationTiers;
    }

    /// @notice Get graduation tier count
    function getGraduationTierCount() external view returns (uint256) {
        return graduationTiers.length;
    }

    /// @notice Get a specific graduation tier (V38: added squaredRatioBps)
    function getGraduationTier(uint256 index) external view returns (
        uint256 threshold,
        uint256 bcVirtual,
        uint256 navMinMulBps,
        uint256 navMaxMulBps,
        uint256 squaredRatioBps
    ) {
        require(index < graduationTiers.length, "Index out of bounds");
        GraduationTier memory tier = graduationTiers[index];
        return (tier.threshold, tier.bcVirtual, tier.navMinMulBps, tier.navMaxMulBps, tier.squaredRatioBps);
    }

    /// @notice Check if graduation tiered mode is enabled
    function isGraduationTieredMode() external view returns (bool) {
        return graduationTieredMode;
    }
}
