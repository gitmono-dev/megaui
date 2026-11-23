// The family name shown in the bottom-left account avatar when the user has no picture.
// A Han name leads with the surname, including a two-character surname. A spaced
// name uses the last word, and a Latin surname is shown by its first letter.

const COMPOUND_SURNAMES = new Set([
  "欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "万俟", "闻人",
  "夏侯", "诸葛", "尉迟", "公羊", "赫连", "澹台", "皇甫", "宗政", "濮阳", "公冶",
  "太叔", "申屠", "公孙", "慕容", "仲孙", "钟离", "长孙", "宇文", "司徒", "鲜于",
  "司空", "闾丘", "子车", "亓官", "司寇", "巫马", "公西", "颛孙", "壤驷", "公良",
  "漆雕", "乐正", "宰父", "谷梁", "拓跋", "夹谷", "轩辕", "令狐", "段干", "百里",
  "呼延", "东郭", "南门", "羊舌", "微生", "公户", "公玉", "公仪", "梁丘", "公仲",
  "公上", "公门", "公山", "公坚", "左丘", "公伯", "西门", "公祖", "第五", "公乘",
  "贯丘", "公皙", "南荣", "东里", "东宫", "仲长", "子书", "子桑", "即墨", "达奚",
  "褚师",
]);

function isHan(character: string): boolean {
  return /\p{Script=Han}/u.test(character);
}

function hanSurname(name: string): string {
  const characters = Array.from(name);
  const first = characters[0] ?? "";
  const pair = characters.slice(0, 2).join("");
  if (characters.length >= 2 && COMPOUND_SURNAMES.has(pair)) return pair;
  return first;
}

/** The account-avatar label for a display name that has no picture. */
export function accountAvatarName(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return "";
  const compact = trimmed.replace(/\s+/gu, "");
  const characters = Array.from(compact);
  const han = characters.filter(isHan).length;
  if (han > 0 && han * 2 >= characters.length) return hanSurname(compact);
  const surname = trimmed.split(/\s+/u).at(-1) ?? trimmed;
  return (Array.from(surname)[0] ?? "").toLocaleUpperCase("en-US");
}
