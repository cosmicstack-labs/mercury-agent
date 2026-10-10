type ColorType = 'foreground' | 'background';
declare const colorize: (text: string, color: string | undefined, type: ColorType) => string;
export default colorize;
