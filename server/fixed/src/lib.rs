//! What the game does by chance or by going round a map, the same on
//! every run and every machine: a replay (`replay.rs`) plays as it was
//! played, here as in the browser it was played in.
//!
//! The standard maps and sets are seeded at random per process, so what
//! the game decides by going round one would differ from run to run: these
//! have a fixed hasher. And `rand`'s `SmallRng` is one generator on a
//! 64-bit machine and another in a browser's 32-bit wasm: a level's cars
//! came at other moments there. This is the 64-bit one, named.

pub type Fixed = std::hash::BuildHasherDefault<Mix>;
pub type HashMap<K, V> = std::collections::HashMap<K, V, Fixed>;
pub type HashSet<T> = std::collections::HashSet<T, Fixed>;
pub type SmallRng = rand_xoshiro::Xoshiro256PlusPlus;

/// A multiply and a rotate a word: the ids and tiles the game hashes are
/// not chosen to collide, and SipHash, built to stand up to keys that are,
/// was a third of the sim. Every word is widened to 64 bits, so a `usize`
/// hashes the same in 32-bit wasm (rustc-hash's FxHasher does not).
#[derive(Default, Clone, Copy)]
pub struct Mix(u64);

impl std::hash::Hasher for Mix {
    fn write(&mut self, bytes: &[u8]) {
        bytes.iter().for_each(|&b| self.write_u64(b as u64));
    }
    fn write_u8(&mut self, n: u8) { self.write_u64(n as u64) }
    fn write_u16(&mut self, n: u16) { self.write_u64(n as u64) }
    fn write_u32(&mut self, n: u32) { self.write_u64(n as u64) }
    fn write_usize(&mut self, n: usize) { self.write_u64(n as u64) }
    fn write_u64(&mut self, n: u64) {
        self.0 = self.0.wrapping_add(n).wrapping_mul(0xf135_7aea_2e62_a9c5);
    }
    fn finish(&self) -> u64 {
        self.0.rotate_left(26)
    }
}
