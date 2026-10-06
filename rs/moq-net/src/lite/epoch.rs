//! Negotiated publisher identity trailers; absent on legacy messages.
use super::Version;
use crate::{Epoch, coding::*};

pub(super) fn encode(w: &mut Encoder<'_>, version: Version, epoch: Option<&Epoch>) -> Result<(), EncodeError> {
	if let Some(epoch) = epoch {
		if !version.has_setup_stream() {
			return Err(EncodeError::Version);
		}
		w.string(epoch.as_str())?;
	}
	Ok(())
}

pub(super) fn decode(r: &mut Decoder<'_>, version: Version) -> Result<Option<Epoch>, DecodeError> {
	if r.is_empty() {
		return Ok(None);
	}
	if !version.has_setup_stream() {
		return Err(DecodeError::Version);
	}
	Ok(Some(r.string()?.parse().map_err(|_| DecodeError::InvalidValue)?))
}
