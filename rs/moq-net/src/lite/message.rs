use bytes::{Buf, BufMut};

use crate::coding::{Decode, DecodeError, Encode, EncodeError, Sizer};

use super::Version;

// Lite control messages are buffered whole before decoding, so the limit is checked as
// soon as the length prefix arrives. The same ceiling as SETUP: paths, track names, and
// hop chains fit with room to spare, and the JavaScript reader matches it.
pub(super) const MAX_MESSAGE_SIZE: usize = 64 * 1024;

/// Read a message length prefix, refusing one past `max` before any of the body arrives.
pub(super) fn decode_size<B: Buf>(buf: &mut B, version: Version, max: usize) -> Result<usize, DecodeError> {
	let size = usize::decode(buf, version)?;
	if size > max {
		return Err(DecodeError::MessageTooLarge { size, max });
	}
	Ok(size)
}

/// A trait for lite messages that are automatically size-prefixed during encoding/decoding.
///
/// Lite messages use a varint size prefix.
pub trait Message: Sized + std::fmt::Debug {
	/// The largest body this receiver accepts for this message.
	const MAX_SIZE: usize = MAX_MESSAGE_SIZE;

	/// Encode this message body (without size prefix).
	fn encode_msg<W: BufMut>(&self, w: &mut W, version: Version) -> Result<(), EncodeError>;

	/// Decode a message body (without size prefix).
	fn decode_msg<B: Buf>(buf: &mut B, version: Version) -> Result<Self, DecodeError>;
}

impl<T: Message> Encode<Version> for T {
	fn encode<W: BufMut>(&self, w: &mut W, version: Version) -> Result<(), EncodeError> {
		tracing::trace!(?self, "encoding");
		let mut sizer = Sizer::default();
		self.encode_msg(&mut sizer, version)?;
		// Never emit a body our own receiver would refuse.
		if sizer.size > Self::MAX_SIZE {
			return Err(EncodeError::TooLarge);
		}
		sizer.size.encode(w, version)?;
		self.encode_msg(w, version)
	}
}

impl<T: Message> Decode<Version> for T {
	fn decode<B: Buf>(buf: &mut B, version: Version) -> Result<Self, DecodeError> {
		let size = decode_size(buf, version, Self::MAX_SIZE)?;

		if tracing::enabled!(tracing::Level::TRACE) {
			if buf.remaining() < size {
				return Err(DecodeError::Short);
			}
			let raw = buf.copy_to_bytes(size);
			let mut slice = &raw[..];
			match Self::decode_msg(&mut slice, version).map_err(DecodeError::complete) {
				Ok(result) => {
					if slice.remaining() > 0 {
						return Err(DecodeError::Long);
					}
					tracing::trace!(?result, "decoded");
					Ok(result)
				}
				Err(e) => {
					tracing::warn!(%e, ?raw, "decode failed");
					Err(e)
				}
			}
		} else {
			if buf.remaining() < size {
				return Err(DecodeError::Short);
			}
			let mut limited = buf.take(size);
			match Self::decode_msg(&mut limited, version).map_err(DecodeError::complete) {
				Ok(result) => {
					if limited.remaining() > 0 {
						return Err(DecodeError::Long);
					}
					Ok(result)
				}
				Err(e) => {
					tracing::warn!(%e, "decode failed");
					Err(e)
				}
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[derive(Debug)]
	struct Empty;

	impl Message for Empty {
		fn encode_msg<W: BufMut>(&self, _: &mut W, _: Version) -> Result<(), EncodeError> {
			Ok(())
		}

		fn decode_msg<B: Buf>(_: &mut B, _: Version) -> Result<Self, DecodeError> {
			Ok(Self)
		}
	}

	#[test]
	fn rejects_oversized_message_before_reading_the_body() {
		let mut wire = Vec::new();
		((MAX_MESSAGE_SIZE + 1) as u64)
			.encode(&mut wire, Version::Lite06)
			.unwrap();

		let err = Empty::decode(&mut wire.as_slice(), Version::Lite06).unwrap_err();
		assert!(matches!(
			err,
			DecodeError::MessageTooLarge {
				size,
				max: MAX_MESSAGE_SIZE,
			} if size == MAX_MESSAGE_SIZE + 1
		));
	}

	#[test]
	fn accepts_message_at_the_limit() {
		let mut wire = Vec::new();
		(MAX_MESSAGE_SIZE as u64).encode(&mut wire, Version::Lite06).unwrap();

		let err = Empty::decode(&mut wire.as_slice(), Version::Lite06).unwrap_err();
		assert!(matches!(err, DecodeError::Short));
	}

	/// A peer can no longer make a control stream buffer megabytes: every message past
	/// the SETUP ceiling is refused at its length prefix, announcements included.
	#[test]
	fn control_messages_are_refused_at_the_prefix() {
		let oversized = |prefix: &[u8]| {
			let mut wire = prefix.to_vec();
			((64 * 1024 + 1) as u64).encode(&mut wire, Version::Lite06).unwrap();
			wire
		};

		let wire = oversized(&[]);
		let err = super::super::Subscribe::decode(&mut wire.as_slice(), Version::Lite06).unwrap_err();
		assert!(matches!(err, DecodeError::MessageTooLarge { .. }), "{err:?}");

		// ANNOUNCE_START: the type, then the length.
		let wire = oversized(&[0]);
		let err = super::super::AnnounceBroadcast::decode(&mut wire.as_slice(), Version::Lite06).unwrap_err();
		assert!(matches!(err, DecodeError::MessageTooLarge { .. }), "{err:?}");
	}

	/// ANNOUNCE_INIT carries the whole initial set in one message, so it keeps the room
	/// a large origin needs.
	#[test]
	fn announce_init_waits_for_a_large_body() {
		let mut wire = Vec::new();
		((1024 * 1024) as u64).encode(&mut wire, Version::Lite02).unwrap();
		let err = super::super::AnnounceInit::decode(&mut wire.as_slice(), Version::Lite02).unwrap_err();
		assert!(matches!(err, DecodeError::Short), "{err:?}");
	}
}
