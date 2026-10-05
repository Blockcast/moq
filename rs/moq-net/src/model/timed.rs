use crate::Timestamp;

/// A value and the time it was captured, written to a timed track.
///
/// An untimed track takes the bare value instead, so a stamp can be neither forgotten on a
/// timed track nor invented on an untimed one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timed<P> {
	/// The value to publish.
	pub value: P,

	/// When the value was captured, at any scale; the track converts it to its own.
	pub at: Timestamp,
}

impl<P> Timed<P> {
	/// Pair a value with when it was captured.
	pub fn new(value: P, at: Timestamp) -> Self {
		Self { value, at }
	}
}
