import QuickLRU from 'quick-lru';
import { type Styles } from './styles.js';
export declare const wrapTextCache: QuickLRU<string, string>;
declare const wrapText: (text: string, maxWidth: number, wrapType: Styles["textWrap"]) => string;
export default wrapText;
