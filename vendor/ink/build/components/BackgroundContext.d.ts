import { type LiteralUnion } from 'type-fest';
import { type ForegroundColorName } from 'ansi-styles';
export type BackgroundColor = LiteralUnion<ForegroundColorName, string>;
export declare const BackgroundContext: import("react").Context<BackgroundColor | undefined>;
