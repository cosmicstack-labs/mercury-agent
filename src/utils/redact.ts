export function redactPhone(phone: string): string {
  if (!phone || phone.length < 6) return '***';
  const visible = phone.slice(0, 4);
  const end = phone.slice(-2);
  return `${visible}***${end}`;
}

export function redactUuid(uuid: string): string {
  if (!uuid || uuid.length < 8) return '***';
  return `${uuid.slice(0, 4)}***`;
}

export function redactIdentity(phone: string, uuid?: string): string {
  const phonePart = redactPhone(phone);
  if (uuid) {
    return `${phonePart} (${redactUuid(uuid)})`;
  }
  return phonePart;
}