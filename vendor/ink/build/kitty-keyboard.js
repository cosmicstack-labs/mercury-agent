// Kitty keyboard protocol flags.
// @see https://sw.kovidgoyal.net/kitty/keyboard-protocol/
export const kittyFlags = {
    disambiguateEscapeCodes: 1,
    reportEventTypes: 2,
    reportAlternateKeys: 4,
    reportAllKeysAsEscapeCodes: 8,
    reportAssociatedText: 16,
};
// Converts an array of flag names to the corresponding bitmask value.
export function resolveFlags(flags) {
    let result = 0;
    for (const flag of flags) {
        // eslint-disable-next-line no-bitwise
        result |= kittyFlags[flag];
    }
    if (flags.includes('reportAssociatedText')) {
        // Associated text is defined only when all-key reporting is enabled.
        // eslint-disable-next-line no-bitwise
        result |= kittyFlags.reportAllKeysAsEscapeCodes;
    }
    return result;
}
// Kitty keyboard modifier bits.
// These are used in the modifier parameter of CSI u sequences.
// Note: The actual modifier value is (modifiers - 1) as per the protocol.
export const kittyModifiers = {
    shift: 1,
    alt: 2,
    ctrl: 4,
    super: 8,
    hyper: 16,
    meta: 32,
    capsLock: 64,
    numLock: 128,
};
