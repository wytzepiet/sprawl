//! What the game does by chance or by going round a map, the same on
//! every run and every machine: a replay (`replay.rs`) plays as it was
//! played, here as in the browser it was played in.
//!
//! The standard maps and sets are seeded at random per process, so what
//! the game decides by going round one would differ from run to run: these
//! have a fixed hasher. And `rand`'s `SmallRng` is one generator on a
//! 64-bit machine and another in a browser's 32-bit wasm: a level's cars
//! came at other moments there. This is the 64-bit one, named.

pub type Fixed = std::hash::BuildHasherDefault<std::hash::DefaultHasher>;
pub type HashMap<K, V> = std::collections::HashMap<K, V, Fixed>;
pub type HashSet<T> = std::collections::HashSet<T, Fixed>;
pub type SmallRng = rand_xoshiro::Xoshiro256PlusPlus;
