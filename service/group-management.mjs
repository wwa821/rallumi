export function validateGroupName(value) {
  const name=typeof value==='string' ? value.trim() : '';
  if (!name || name.length>40 || /[\x00-\x1f\x7f]/u.test(name)) throw Error('群名请填写 1–40 字');
  return name;
}
