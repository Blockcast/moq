//! Priority conversion between the IETF wire and the MoQ model.

/// Convert an IETF subscriber priority into the model's higher-first priority.
pub(super) const fn from_wire(priority: u8) -> u8 {
	u8::MAX - priority
}

/// Convert the model's higher-first priority into an IETF subscriber priority.
pub(super) const fn to_wire(priority: u8) -> u8 {
	u8::MAX - priority
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ietf_priority_is_lower_first() {
		assert_eq!(from_wire(0), u8::MAX);
		assert_eq!(from_wire(u8::MAX), 0);
		assert_eq!(to_wire(u8::MAX), 0);
		assert_eq!(to_wire(0), u8::MAX);
		assert!((0u8..u8::MAX).all(|priority| from_wire(priority) > from_wire(priority + 1)));
	}

	#[test]
	fn priority_round_trips() {
		assert!((0u8..=u8::MAX).all(|priority| from_wire(to_wire(priority)) == priority));
	}

	/// draft-ramadan-moq-fec section 10 bands, on the IETF wire's lower-first
	/// scale: Source Media is 64..=191 and AL-FEC repair is 192..=255,
	/// ascending by repair layer. The model ranks higher-first, so a repair
	/// priority that is COPIED here rather than converted inverts both
	/// orderings at once: repair preempts the source it repairs, and the
	/// highest repair layer outranks layer 0.
	#[test]
	fn converted_repair_bands_yield_to_source_and_order_by_layer() {
		// Both endpoints of the repair band.
		assert_eq!(from_wire(192), 63);
		assert_eq!(from_wire(255), 0);
		// Both endpoints of the source media band.
		assert_eq!(from_wire(64), 191);
		assert_eq!(from_wire(191), 64);

		// The adjacent boundary is the tightest case: the LEAST urgent source
		// must still preempt the MOST urgent repair, or the bands overlap.
		assert!(
			from_wire(191) > from_wire(192),
			"the least urgent source media must preempt the most urgent repair"
		);

		// Repair layers ascend on the wire, so they must descend in the model.
		let layer_0 = from_wire(240);
		let layer_1 = from_wire(241);
		assert!(layer_0 > layer_1, "repair layer 0 must preempt layer 1");
		assert!(
			from_wire(128) > layer_0,
			"a source track must preempt the repair that protects it"
		);
	}
}
