export const isTty = (stream) => 'isTTY' in stream && stream.isTTY === true;
const isRawModeStream = (stdin) => isTty(stdin) &&
    'setRawMode' in stdin &&
    typeof stdin.setRawMode === 'function';
export const getRawModeStream = (stdin) => (isRawModeStream(stdin) ? stdin : undefined);
