const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const FEE = E(0.05);

async function deploy() {
  const [owner, treasury, alice, bob, carol, dave] = await ethers.getSigners();
  const f = await (await ethers.getContractFactory("Fanout")).deploy(owner.address, treasury.address);
  const tok = await (await ethers.getContractFactory("MockToken")).deploy("USD Test", "USDT", 6);
  const feeTok = await (await ethers.getContractFactory("FeeToken")).deploy();
  await tok.mint(alice.address, 1_000_000n * 10n ** 6n);
  await feeTok.mint(alice.address, E(1000));
  await tok.connect(alice).approve(f.target, ethers.MaxUint256);
  await feeTok.connect(alice).approve(f.target, ethers.MaxUint256);
  return { f, tok, feeTok, owner, treasury, alice, bob, carol, dave };
}

describe("Fanout", () => {
  describe("native", () => {
    it("sends each amount and keeps only the fee", async () => {
      const { f, alice, bob, carol, dave } = await loadFixture(deploy);
      const to = [bob.address, carol.address, dave.address], amt = [E(1), E(2.5), E(0.25)];
      await expect(f.connect(alice).sendNative(to, amt, { value: E(3.75) + FEE }))
        .to.changeEtherBalances([bob, carol, dave, alice], [E(1), E(2.5), E(0.25), -(E(3.75) + FEE)]);
      expect(await ethers.provider.getBalance(f.target)).to.equal(FEE);
      expect(await f.feesAccrued()).to.equal(FEE);
    });

    it("requires exact value", async () => {
      const { f, alice, bob } = await loadFixture(deploy);
      await expect(f.connect(alice).sendNative([bob.address], [E(1)], { value: E(1) })).to.be.revertedWithCustomError(f, "WrongAmount");
      await expect(f.connect(alice).sendNative([bob.address], [E(1)], { value: E(1.06) })).to.be.revertedWithCustomError(f, "WrongAmount");
    });

    it("all-or-nothing: one failing recipient reverts the batch", async () => {
      const { f, alice, bob } = await loadFixture(deploy);
      const rej = await (await ethers.getContractFactory("Rejecter")).deploy();
      await expect(f.connect(alice).sendNative([bob.address, rej.target], [E(1), E(1)], { value: E(2) + FEE }))
        .to.be.revertedWithCustomError(f, "TransferFailed").withArgs(1);
      expect(await ethers.provider.getBalance(f.target)).to.equal(0);
    });

    it("blocks reentrancy from a recipient", async () => {
      const { f, alice } = await loadFixture(deploy);
      const re = await (await ethers.getContractFactory("Reenterer")).deploy(f.target);
      await expect(f.connect(alice).sendNative([re.target], [E(1)], { value: E(1) + FEE }))
        .to.be.revertedWithCustomError(f, "TransferFailed");
    });
  });

  describe("token", () => {
    it("moves tokens straight from sender to recipients", async () => {
      const { f, tok, alice, bob, carol } = await loadFixture(deploy);
      await f.connect(alice).sendToken(tok.target, [bob.address, carol.address], [5_000_000n, 7_500_000n], { value: FEE });
      expect(await tok.balanceOf(bob.address)).to.equal(5_000_000n);
      expect(await tok.balanceOf(carol.address)).to.equal(7_500_000n);
      expect(await tok.balanceOf(f.target)).to.equal(0);
    });

    it("works with fee-on-transfer tokens (recipient gets what the token delivers)", async () => {
      const { f, feeTok, alice, bob } = await loadFixture(deploy);
      await f.connect(alice).sendToken(feeTok.target, [bob.address], [E(100)], { value: FEE });
      expect(await feeTok.balanceOf(bob.address)).to.equal(E(99));
      expect(await feeTok.balanceOf(f.target)).to.equal(0);
    });

    it("needs the fee in BOT and enough allowance", async () => {
      const { f, tok, alice, bob, carol } = await loadFixture(deploy);
      await expect(f.connect(alice).sendToken(tok.target, [bob.address], [1n])).to.be.revertedWithCustomError(f, "WrongAmount");
      await expect(f.connect(bob).sendToken(tok.target, [carol.address], [1n], { value: FEE })).to.be.reverted;
      await expect(f.connect(alice).sendToken(ethers.ZeroAddress, [bob.address], [1n], { value: FEE })).to.be.revertedWithCustomError(f, "InvalidParams");
    });
  });

  describe("validation", () => {
    it("rejects empty, mismatched, too long, zero address and zero amount", async () => {
      const { f, alice, bob } = await loadFixture(deploy);
      const v = { value: FEE + 1n };
      await expect(f.connect(alice).sendNative([], [], { value: FEE })).to.be.revertedWithCustomError(f, "InvalidParams");
      await expect(f.connect(alice).sendNative([bob.address], [1n, 1n], v)).to.be.revertedWithCustomError(f, "InvalidParams");
      await expect(f.connect(alice).sendNative([ethers.ZeroAddress], [1n], v)).to.be.revertedWithCustomError(f, "InvalidParams");
      await expect(f.connect(alice).sendNative([bob.address], [0n], { value: FEE })).to.be.revertedWithCustomError(f, "InvalidParams");
      const many = Array(301).fill(bob.address), ones = Array(301).fill(1n);
      await expect(f.connect(alice).sendNative(many, ones, { value: FEE + 301n })).to.be.revertedWithCustomError(f, "InvalidParams");
    });

    it("handles a full 300-recipient batch", async () => {
      const { f, alice } = await loadFixture(deploy);
      const to = Array.from({ length: 300 }, (_, i) => ethers.getAddress("0x" + (i + 0x10000).toString(16).padStart(40, "0")));
      const amt = Array(300).fill(E(0.001));
      await f.connect(alice).sendNative(to, amt, { value: E(0.3) + FEE });
      expect(await ethers.provider.getBalance(to[299])).to.equal(E(0.001));
    });
  });

  describe("fees & admin", () => {
    it("anyone can push fees to the treasury", async () => {
      const { f, tok, treasury, alice, bob, carol } = await loadFixture(deploy);
      await f.connect(alice).sendNative([bob.address], [E(1)], { value: E(1) + FEE });
      await f.connect(alice).sendToken(tok.target, [bob.address], [1n], { value: FEE });
      await expect(f.connect(carol).collectFees()).to.changeEtherBalance(treasury, FEE * 2n);
      await expect(f.collectFees()).to.be.revertedWithCustomError(f, "NothingToCollect");
    });

    it("fee capped at 1 BOT, owner only; can be zero", async () => {
      const { f, owner, alice, bob, treasury } = await loadFixture(deploy);
      await expect(f.connect(alice).setConfig(0, treasury.address)).to.be.revertedWithCustomError(f, "OwnableUnauthorizedAccount");
      await expect(f.connect(owner).setConfig(E(1.01), treasury.address)).to.be.revertedWithCustomError(f, "InvalidParams");
      await f.connect(owner).setConfig(0, treasury.address);
      await f.connect(alice).sendNative([bob.address], [E(1)], { value: E(1) });
    });

    it("pause blocks sends", async () => {
      const { f, owner, alice, bob } = await loadFixture(deploy);
      await f.connect(owner).pause();
      await expect(f.connect(alice).sendNative([bob.address], [1n], { value: FEE + 1n })).to.be.revertedWithCustomError(f, "EnforcedPause");
    });

    it("owner has no way to move user funds", async () => {
      const { f } = await loadFixture(deploy);
      const fns = f.interface.fragments.filter(x => x.type === "function" && !["view", "pure"].includes(x.stateMutability)).map(x => x.name).sort();
      expect(fns).to.deep.equal(["acceptOwnership", "collectFees", "pause", "renounceOwnership", "sendNative", "sendToken", "setConfig", "transferOwnership", "unpause"]);
    });
  });
});
