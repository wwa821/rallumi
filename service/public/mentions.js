export function everyoneMention(name, memberNames) {
  return name === '全体' || (name.toLowerCase() === 'all' &&
    !memberNames.some(member => member.toLowerCase() === 'all'));
}

export function searchRank(query,...fields) {
  const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const [name,...details] = fields.map(normalize);
  const text = [name,...details].join(' ');
  if (!words.every(word=>text.includes(word))) return Infinity;
  const phrase = words.join(' ');
  return name===phrase ? 0 : name.startsWith(phrase) ? 1 : name.includes(phrase) ? 2 : 3;
}
