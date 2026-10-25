/**
 * Emojis offered for page icons, by category, each with words to search by.
 * A curated set rather than a full emoji library; any other emoji can be
 * pasted into the picker's search box.
 */
export const EMOJI_CATEGORIES: { name: string; emojis: [emoji: string, words: string][] }[] = [
  {
    name: 'Work',
    emojis: [
      ['📄', 'page document file'], ['📝', 'memo note write'], ['📌', 'pin pinned'], ['📎', 'paperclip attach'],
      ['📊', 'chart bar stats'], ['📈', 'chart up growth trend'], ['📉', 'chart down decline'], ['🗂️', 'dividers index folders'],
      ['📁', 'folder'], ['📂', 'open folder'], ['🗃️', 'card box archive'], ['🗄️', 'cabinet files'],
      ['📋', 'clipboard list'], ['📅', 'calendar date'], ['🗓️', 'calendar schedule'], ['⏰', 'alarm clock time'],
      ['⏳', 'hourglass time wait'], ['✅', 'check done task'], ['☑️', 'checkbox done'], ['✏️', 'pencil edit'],
      ['🖊️', 'pen write'], ['📚', 'books library learn'], ['📖', 'book open read'], ['📓', 'notebook'],
      ['🔖', 'bookmark'], ['🏷️', 'label tag'], ['💼', 'briefcase work business'], ['🏢', 'office building company'],
      ['🗺️', 'map plan'], ['🧭', 'compass direction navigate'], ['🎯', 'target goal okr aim'], ['🏆', 'trophy win award'],
      ['🥇', 'medal first gold'], ['🚀', 'rocket launch ship'], ['⚙️', 'gear settings operations'], ['🔧', 'wrench tool fix'],
      ['🛠️', 'tools build'], ['🔨', 'hammer build'], ['🧰', 'toolbox kit'], ['🔬', 'microscope research'],
      ['🧪', 'test tube experiment'], ['🧠', 'brain think ai'], ['💡', 'idea light bulb'], ['🔍', 'search magnifier find'],
      ['🔑', 'key access'], ['🔒', 'lock private secure'], ['🛡️', 'shield safety security'], ['⚖️', 'scales balance legal'],
      ['💰', 'money bag budget'], ['💵', 'dollar money cash'], ['💸', 'money spend cost'], ['🧾', 'receipt invoice'],
      ['💳', 'card payment'], ['📦', 'package box product'], ['🛒', 'cart shop'], ['🏦', 'bank finance'],
      ['📣', 'megaphone announce marketing'], ['📢', 'loudspeaker announce'], ['📬', 'mailbox mail'], ['✉️', 'envelope email'],
      ['💬', 'speech chat comment'], ['🗣️', 'speaking talk'], ['📞', 'phone call'], ['🎤', 'microphone talk podcast'],
      ['🎥', 'camera video film'], ['📷', 'camera photo'], ['🖥️', 'desktop computer'], ['💻', 'laptop computer code'],
      ['⌨️', 'keyboard'], ['🖱️', 'mouse'], ['🌐', 'globe web internet'], ['🔗', 'link chain'],
    ],
  },
  {
    name: 'People',
    emojis: [
      ['😀', 'grin smile happy'], ['😊', 'smile blush'], ['🙂', 'slight smile'], ['😎', 'cool sunglasses'],
      ['🤔', 'thinking'], ['🤓', 'nerd'], ['😅', 'sweat smile'], ['😍', 'love heart eyes'],
      ['🥳', 'party celebrate'], ['😴', 'sleep'], ['🤯', 'mind blown'], ['😬', 'grimace'],
      ['👋', 'wave hello'], ['👍', 'thumbs up yes'], ['👎', 'thumbs down no'], ['👏', 'clap applause'],
      ['🙌', 'raised hands celebrate'], ['🤝', 'handshake deal partner'], ['🙏', 'pray thanks please'], ['💪', 'muscle strong'],
      ['👀', 'eyes look review'], ['🧑‍💻', 'technologist developer'], ['🧑‍🏫', 'teacher'], ['🧑‍🎓', 'student graduate'],
      ['👥', 'people team group'], ['👤', 'person user'], ['🧑‍🤝‍🧑', 'people together'], ['👶', 'baby new'],
    ],
  },
  {
    name: 'Nature',
    emojis: [
      ['🌱', 'seedling grow start'], ['🌿', 'herb leaf'], ['🌳', 'tree'], ['🌲', 'evergreen tree'],
      ['🍀', 'clover luck'], ['🌸', 'blossom flower'], ['🌻', 'sunflower'], ['🌵', 'cactus'],
      ['🔥', 'fire hot'], ['⚡', 'lightning fast energy'], ['💧', 'drop water'], ['🌊', 'wave ocean'],
      ['☀️', 'sun'], ['🌙', 'moon night'], ['⭐', 'star'], ['🌟', 'glowing star'],
      ['🌈', 'rainbow'], ['❄️', 'snowflake cold'], ['🌍', 'earth globe world'], ['🪐', 'planet'],
      ['🐶', 'dog'], ['🐱', 'cat'], ['🦊', 'fox'], ['🦉', 'owl wise'],
      ['🐝', 'bee busy'], ['🦋', 'butterfly'], ['🐢', 'turtle slow'], ['🐙', 'octopus'],
    ],
  },
  {
    name: 'Food & things',
    emojis: [
      ['☕', 'coffee'], ['🍵', 'tea'], ['🍎', 'apple'], ['🍕', 'pizza'],
      ['🍰', 'cake'], ['🎂', 'birthday cake'], ['🍪', 'cookie'], ['🍿', 'popcorn'],
      ['🎉', 'party popper celebrate'], ['🎁', 'gift present'], ['🎈', 'balloon'], ['🎨', 'art palette design'],
      ['🎮', 'game controller'], ['🧩', 'puzzle piece'], ['♟️', 'chess strategy'], ['🎲', 'dice chance'],
      ['🎵', 'music note'], ['🎧', 'headphones listen'], ['📺', 'tv'], ['🕹️', 'joystick'],
      ['🏠', 'house home'], ['🏡', 'home garden'], ['🏫', 'school'], ['🏛️', 'institution classical'],
      ['✈️', 'airplane travel'], ['🚗', 'car'], ['🚲', 'bicycle'], ['🚦', 'traffic light status'],
      ['⛵', 'sailboat'], ['🏔️', 'mountain'], ['🏕️', 'camping'], ['🗽', 'statue liberty'],
    ],
  },
  {
    name: 'Symbols',
    emojis: [
      ['❤️', 'heart love'], ['🧡', 'orange heart'], ['💛', 'yellow heart'], ['💚', 'green heart'],
      ['💙', 'blue heart'], ['💜', 'purple heart'], ['🖤', 'black heart'], ['🤍', 'white heart'],
      ['✨', 'sparkles new'], ['💥', 'boom'], ['💯', 'hundred'], ['❗', 'exclamation important'],
      ['❓', 'question'], ['⚠️', 'warning caution'], ['🚫', 'prohibited no'], ['⛔', 'no entry stop'],
      ['✔️', 'check'], ['❌', 'cross no'], ['➕', 'plus add'], ['➖', 'minus'],
      ['🔴', 'red circle'], ['🟠', 'orange circle'], ['🟡', 'yellow circle'], ['🟢', 'green circle'],
      ['🔵', 'blue circle'], ['🟣', 'purple circle'], ['⚫', 'black circle'], ['⚪', 'white circle'],
      ['🔺', 'red triangle up'], ['🔻', 'red triangle down'], ['🔶', 'orange diamond'], ['🔷', 'blue diamond'],
      ['♻️', 'recycle'], ['🔁', 'repeat loop'], ['🔄', 'refresh cycle'], ['➡️', 'arrow right'],
      ['⬆️', 'arrow up'], ['⬇️', 'arrow down'], ['ℹ️', 'information'], ['🆕', 'new'],
      ['#️⃣', 'hash number'], ['0️⃣', 'zero'], ['1️⃣', 'one'], ['2️⃣', 'two'],
      ['3️⃣', 'three'], ['4️⃣', 'four'], ['5️⃣', 'five'], ['🔟', 'ten'],
    ],
  },
];
