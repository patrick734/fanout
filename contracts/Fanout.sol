// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Fanout
/// @notice Send BOT or any ERC-20 to many addresses in one transaction.
///         Batches are all-or-nothing: if any single transfer fails, nothing is sent.
///         Tokens move straight from the sender to each recipient; the contract never
///         holds them. The only thing it keeps is the flat per-batch fee in BOT.
contract Fanout is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_FEE = 1 ether;   // fee can never exceed 1 BOT
    uint256 public constant MAX_RECIPIENTS = 300;

    uint256 public fee = 0.05 ether;
    address public treasury;
    uint256 public feesAccrued;

    event SentNative(address indexed sender, uint256 recipients, uint256 total);
    event SentToken(address indexed sender, address indexed token, uint256 recipients, uint256 total);
    event FeesCollected(address indexed treasury, uint256 amount);
    event ConfigUpdated(uint256 fee, address treasury);

    error InvalidParams();
    error WrongAmount();
    error TransferFailed(uint256 index);
    error NothingToCollect();

    constructor(address owner_, address treasury_) Ownable(owner_) {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
    }

    /// @notice Send BOT. msg.value must equal the sum of `amounts` plus `fee`.
    function sendNative(address[] calldata to, uint256[] calldata amounts)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        uint256 n = _check(to, amounts);
        uint256 total;
        for (uint256 i; i < n; ++i) total += amounts[i];
        if (msg.value != total + fee) revert WrongAmount();
        feesAccrued += fee;
        for (uint256 i; i < n; ++i) {
            (bool ok, ) = payable(to[i]).call{value: amounts[i]}("");
            if (!ok) revert TransferFailed(i);
        }
        emit SentNative(msg.sender, n, total);
    }

    /// @notice Send an ERC-20 straight from your wallet. Approve this contract for the
    ///         total first, and send exactly `fee` in BOT with the call.
    function sendToken(address token, address[] calldata to, uint256[] calldata amounts)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (token == address(0)) revert InvalidParams();
        uint256 n = _check(to, amounts);
        if (msg.value != fee) revert WrongAmount();
        feesAccrued += fee;
        IERC20 t = IERC20(token);
        uint256 total;
        for (uint256 i; i < n; ++i) {
            t.safeTransferFrom(msg.sender, to[i], amounts[i]);
            total += amounts[i];
        }
        emit SentToken(msg.sender, token, n, total);
    }

    /// @notice Sends accrued fees to the treasury. Anyone may call it.
    function collectFees() external nonReentrant {
        uint256 amount = feesAccrued;
        if (amount == 0) revert NothingToCollect();
        feesAccrued = 0;
        (bool ok, ) = payable(treasury).call{value: amount}("");
        if (!ok) revert TransferFailed(type(uint256).max);
        emit FeesCollected(treasury, amount);
    }

    function setConfig(uint256 fee_, address treasury_) external onlyOwner {
        if (fee_ > MAX_FEE || treasury_ == address(0)) revert InvalidParams();
        fee = fee_;
        treasury = treasury_;
        emit ConfigUpdated(fee_, treasury_);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function _check(address[] calldata to, uint256[] calldata amounts) private pure returns (uint256 n) {
        n = to.length;
        if (n == 0 || n > MAX_RECIPIENTS || n != amounts.length) revert InvalidParams();
        for (uint256 i; i < n; ++i) {
            if (to[i] == address(0) || amounts[i] == 0) revert InvalidParams();
        }
    }
}
