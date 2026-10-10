type ControlStringType = 'osc' | 'dcs' | 'pm' | 'apc' | 'sos';
type CsiToken = {
    readonly type: 'csi';
    readonly value: string;
    readonly parameterString: string;
    readonly intermediateString: string;
    readonly finalCharacter: string;
};
type EscToken = {
    readonly type: 'esc';
    readonly value: string;
    readonly intermediateString: string;
    readonly finalCharacter: string;
};
type ControlStringToken = {
    readonly type: ControlStringType;
    readonly value: string;
};
type TextToken = {
    readonly type: 'text';
    readonly value: string;
};
type StToken = {
    readonly type: 'st';
    readonly value: string;
};
type C1Token = {
    readonly type: 'c1';
    readonly value: string;
};
type InvalidToken = {
    readonly type: 'invalid';
    readonly value: string;
};
export type AnsiToken = TextToken | CsiToken | EscToken | ControlStringToken | StToken | C1Token | InvalidToken;
export declare const hasAnsiControlCharacters: (text: string) => boolean;
export declare const tokenizeAnsi: (text: string) => AnsiToken[];
export {};
