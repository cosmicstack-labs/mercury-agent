/**
 * Texte sûr pour un corps JSON destiné à un fournisseur.
 *
 * Un surrogate UTF-16 isolé — ce que produit n'importe quelle coupe par index sur une chaîne qui
 * contient un emoji — traverse `JSON.stringify` sous la forme `\ud83c`, et certains serveurs
 * refusent le corps entier : DeepSeek répond « 400 Failed to parse the request body as JSON:
 * messages[6].content: unexpected end of hex escape ». Mesuré sur api.deepseek.com : la même
 * chaîne avec le surrogate *brut* en UTF-8 passe (200), la même en séquence d'échappement est
 * rejetée (400). La coupe doit donc tomber entre deux points de code, et le texte envoyé ne doit
 * plus contenir de moitié de paire.
 */

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHigh(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLow(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

/**
 * Retire les surrogates isolés. Une paire valide (emoji) est conservée telle quelle : seules les
 * moitiés orphelines — celles qui font échouer le serveur — disparaissent.
 */
export function stripLoneSurrogates(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isHigh(code)) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (isLow(next)) {
        out += text[i] + text[i + 1];
        i += 1;
        continue;
      }
      continue; // high sans low : on jette la moitié
    }
    if (isLow(code)) continue; // low sans high : on jette la moitié
    out += text[i];
  }
  return out;
}

/**
 * Coupe à `max` caractères sans jamais séparer une paire de surrogates, puis retire ce qui
 * resterait d'isolé. `max` compte des unités UTF-16, comme `String.prototype.length`.
 */
export function truncateText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return stripLoneSurrogates(text);
  let end = max;
  if (end > 0 && isHigh(text.charCodeAt(end - 1))) end -= 1; // la paire commençait juste avant la coupe
  return stripLoneSurrogates(text.slice(0, end));
}
