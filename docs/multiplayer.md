# Multiplayer: one world, many towns, one sea

Status: specification, argued 2026-09-10, rewritten 2026-10-10 around
trade (`trade.md`) and shipping (`shipping.md`). Nothing here is built.
The version before this, with the edge as the terminal, prices, the band
and commuters between towns, last lived at `9b99be0`. The archived guide's
one hard rule survives: a road that would disconnect someone from what
they depend on can never be demolished.

## The idea

Several players build towns in one world of islands and one sea. Each town
has its own build, treasury and GDP; the sea and the shipping company are
shared. Towns reach each other and the world by sea, by default; a road
between two towns exists only where their players build one.

Three rules carry it:

1. **Every town is coastal at birth.** A town starts with its harbour on a
   coast; the interior is what it grows into. Nobody is landlocked young.
2. **The sea is everyone's.** Every ship is the shipping company's, on
   lines through everyone's harbours (`shipping.md`). A town's harbour can
   be a hub for others' cargo and earn dues for it; a big port in a good
   spot is a way to play.
3. **The claim is influence, and influence is traffic.** Where two towns
   share land, who may build follows from whose traffic uses it (§The
   claim).

## Spawning

Towns spawn on a coast with a harbour, spaced so neither is in the other's
shadow: further apart than a town grows in its first season. Fifty spawns
on one day are fifty coastal towns, each with its door, on islands that
may be shared. Separation later is geography: a strait, a mountain, the
open sea between.

## Trade between players

By listings, standing offers and contracts on the trade board of the
container port, which is the Exchange (`trade.md`). Every trade is a
shipment that sails, through hubs if the planner finds them, or drives
where a road joins the two towns, and can be followed. The seller always
delivers, from the world if it must (`trade.md` §Contracts).

**Why a road gets built:** a neighbour close enough that a lorry beats a
ship, both ways, every day. Roads between towns are a choice, built when
they pay, and never needed for a town to work.

## The claim

A road tile holds one stock per player, filled by that player's vehicles
driving it, drained by time, and seeded on a driveway by the building
placed at it. What a player may do follows from whose stock is largest:

- **Build beside a road where your influence is the largest.** A road two
  towns' lorries share is both towns', and either may build beside it.
  Borders follow use and move as towns grow, drawn by nobody.
- **Demolish only what is mostly yours**, and never a tile whose loss would
  disconnect another player's traffic from what it reaches. That makes
  griefing pointless: a road two towns depend on can be cut by neither.
- **Drafts reserve.** A player's drafted roads and buildings hold their
  tiles against everyone else until committed or discarded (`game.md`
  §Drafts).
- **No table of territory.** Ownership is derived from what drives, like
  every other index; a world reloaded settles the same claims from the same
  traffic.

Influence cannot be farmed, because vehicles go where they are needed, not
where the player wants a claim.

## Open

1. The width of a road's claim, and whether a building's influence reaches
   the land around it.
2. Whether influence needs buildings as a source at all, or a driveway is
   the only seed.
3. How towns on one island find each other if players never build a road:
   whether that is fine, since the sea joins them anyway.
