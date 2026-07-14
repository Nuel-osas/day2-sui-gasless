/// FUSD — a test stablecoin for the gasless workshop.
///
/// It's a plain `Coin<FUSD>` (6 decimals, like most stablecoins). The only
/// non-standard bit is the `Faucet`: the `TreasuryCap` is wrapped in a SHARED
/// object with a public `mint`, so anyone in the workshop can claim test coins.
/// Nothing here knows about gas — gaslessness is a property of how the *transfer*
/// transaction is sponsored, not of the coin.
module fake_usd::fusd;

use sui::coin::{Self, Coin, TreasuryCap};

/// One-time witness — the coin type.
public struct FUSD has drop {}

/// Shared faucet holding the mint authority.
public struct Faucet has key {
    id: UID,
    cap: TreasuryCap<FUSD>,
}

fun init(witness: FUSD, ctx: &mut TxContext) {
    let (treasury, metadata) = coin::create_currency(
        witness,
        6,
        b"FUSD",
        b"Fake USD",
        b"Test stablecoin for the Sui gasless workshop",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::share_object(Faucet { id: object::new(ctx), cap: treasury });
}

/// Claim `amount` test stablecoins (raw units; 1 FUSD = 1_000_000). Anyone can call.
public entry fun mint(faucet: &mut Faucet, amount: u64, recipient: address, ctx: &mut TxContext) {
    let c = coin::mint(&mut faucet.cap, amount, ctx);
    transfer::public_transfer(c, recipient);
}

/// Return a minted coin instead of transferring it — handy for composing in a PTB.
public fun mint_coin(faucet: &mut Faucet, amount: u64, ctx: &mut TxContext): Coin<FUSD> {
    coin::mint(&mut faucet.cap, amount, ctx)
}

/// Send `amount` FUSD from `coin` to `recipient`. This is a MoveCall INTO this
/// package, so a gas station can strictly allowlist "only sponsor fusd calls" —
/// a plain coin transfer would carry no MoveCall to authorize.
public entry fun pay(coin: &mut Coin<FUSD>, amount: u64, recipient: address, ctx: &mut TxContext) {
    let part = coin.split(amount, ctx);
    transfer::public_transfer(part, recipient);
}
