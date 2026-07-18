/** Per-icon default template for the Text field. Keyed by iconQuad. */
export const MARKER_DEFAULT_TEXT: Record<string, string> = {
  "ts-trp":          "TRP 1##",
  "ts-wp":           "#",
  "ts-cp":           "#",
  "ts-mep":          "#",
  "ts-bof":          "SBF $",
  "ts-abf":          "ABF $",
  "ts-aoa-left":     "AOA $",
  "ts-aoa-right":    "AOA $",
  "ts-aoa-straight": "AOA $",
};

/** Icon quads whose `#` counter starts at 0 instead of 1. */
export const START_FROM_ZERO: ReadonlySet<string> = new Set(["ts-trp"]);

export const NATO_PHONETIC: readonly string[] = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
  "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa",
  "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey",
  "Xray", "Yankee", "Zulu",
];

export const RUSSIAN_PHONETIC: readonly string[] = [
  "Анна", "Борис", "Василий", "Григорий", "Дмитрий", "Елена", "Женя",
  "Зинаида", "Иван", "Константин", "Леонид", "Михаил", "Николай", "Ольга",
  "Павел", "Роман", "Семён", "Татьяна", "Ульяна", "Фёдор", "Харитон",
  "Цапля", "Человек", "Шура", "Щука", "Эхо", "Юрий", "Яков",
];

export const FOOD_FALLBACK_EN: readonly string[] = [
  "Pizza", "Taco", "Sushi", "Ramen", "Burger", "Donut", "Bagel", "Pretzel",
  "Curry", "Pasta", "Kebab", "Falafel", "Dumpling", "Pancake", "Waffle",
  "Croissant", "Baguette", "Pierogi", "Risotto", "Paella", "Nachos",
  "Empanada", "Samosa", "Biryani", "Gyros", "Schnitzel", "Goulash",
  "Borscht", "Lasagna", "Tiramisu",
];

export const FOOD_FALLBACK_RU: readonly string[] = [
  "Пельмень", "Борщ", "Блин", "Пирожок", "Вареник", "Сырник", "Шашлык",
  "Плов", "Селёдка", "Оливье", "Винегрет", "Котлета", "Солянка", "Щи",
  "Окрошка", "Голубцы", "Бефстроганов", "Гречка", "Каша", "Расстегай",
  "Кулебяка", "Ватрушка", "Пряник", "Баранка", "Сушка", "Холодец",
  "Квас", "Кисель", "Творог", "Сметана",
];

