export function everyoneMention(name, memberNames) {
  return name === '全体' || (name.toLowerCase() === 'all' &&
    !memberNames.some(member => member.toLowerCase() === 'all'));
}
