export declare const kittyFlags: {
    readonly disambiguateEscapeCodes: 1;
    readonly reportEventTypes: 2;
    readonly reportAlternateKeys: 4;
    readonly reportAllKeysAsEscapeCodes: 8;
    readonly reportAssociatedText: 16;
};
export type KittyFlagName = keyof typeof kittyFlags;
export declare function resolveFlags(flags: KittyFlagName[]): number;
export declare const kittyModifiers: {
    readonly shift: 1;
    readonly alt: 2;
    readonly ctrl: 4;
    readonly super: 8;
    readonly hyper: 16;
    readonly meta: 32;
    readonly capsLock: 64;
    readonly numLock: 128;
};
export type KittyKeyboardOptions = {
    mode?: 'auto' | 'enabled' | 'disabled';
    flags?: KittyFlagName[];
};
