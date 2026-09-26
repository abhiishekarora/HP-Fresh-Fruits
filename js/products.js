/*
 * Product catalogue. Each product shows a real `photo`. These come from
 * Wikimedia Commons (free licences; credits are listed in the site footer).
 * To use your own photo instead, set `photo: "images/photos/<id>.jpg"`.
 * If a photo can't load, the card falls back to `image` (an illustration)
 * or `emoji`, on a `tint` background.
 */

// Wikimedia Commons serves a resized copy of any file through this address.
function commonsPhoto(file) {
  const name = file.replace(/ /g, "_");
  return {
    src: "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(name) + "?width=800",
    source: "https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(name),
    title: file,
  };
}

window.PRODUCTS = [
  { id: "dragon-fruit",   name: "Dragon Fruit",      photo: commonsPhoto("Pitaya cross section ed2.jpg"), origin: "Vietnam",     price: 249, unit: "per piece",  image: "images/dragon-fruit.svg", tint: "#fde7f0", category: "Tropical", description: "Mildly sweet white flesh speckled with seeds, wrapped in a vivid pink skin." },
  { id: "avocado-hass",   name: "Hass Avocado",      photo: commonsPhoto("Avocado Hass - single and halved.jpg"), origin: "Mexico",      price: 399, unit: "pack of 3",  emoji: "🥑", tint: "#eaf5e1", category: "Tropical", description: "Creamy, buttery avocados picked at peak maturity. Ripen at room temperature." },
  { id: "kiwi-gold",      name: "Golden Kiwi",       photo: commonsPhoto("Kiwifruit 'Gold' cross section.jpg"), origin: "New Zealand", price: 349, unit: "pack of 6",  emoji: "🥝", tint: "#f4f7dc", category: "Berries & Kiwi", description: "Smooth-skinned kiwi with sweet, tropical golden flesh and low acidity." },
  { id: "blueberries",    name: "Blueberries",       photo: commonsPhoto("Blueberries 3872x2592.jpg"), origin: "Peru",        price: 299, unit: "125 g box",  emoji: "🫐", tint: "#e6ebfa", category: "Berries & Kiwi", description: "Plump, dusty-blue berries, perfect for breakfast bowls and baking." },
  { id: "mangosteen",     name: "Mangosteen",        photo: commonsPhoto("Mangosteens - whole and opened.jpg"), origin: "Thailand",    price: 699, unit: "500 g",      image: "images/mangosteen.svg", tint: "#efe6f5", category: "Tropical", description: "The 'queen of fruits': juicy, tangy-sweet segments under a deep purple rind." },
  { id: "rambutan",       name: "Rambutan",          photo: commonsPhoto("Rambutan fruits (Nephelium lappaceum).JPG"), origin: "Malaysia",    price: 549, unit: "500 g",      image: "images/rambutan.svg", tint: "#fde8e4", category: "Tropical", description: "Hairy red shell hiding translucent, lychee-like flesh with a floral finish." },
  { id: "apple-fuji",     name: "Fuji Apple",        photo: commonsPhoto("Fuji apple.jpg"), origin: "Japan",       price: 459, unit: "pack of 4",  emoji: "🍎", tint: "#fdeaea", category: "Orchard", description: "Crisp, dense and honey-sweet. A premium dessert apple with a long shelf life." },
  { id: "pear-korean",    name: "Korean Pear",       photo: commonsPhoto("Korean.pear-Bae-Singo-01.jpg"), origin: "South Korea", price: 499, unit: "pack of 2",  emoji: "🍐", tint: "#f5f3dc", category: "Orchard", description: "Large, round and incredibly juicy with a crunchy, refreshing bite." },
  { id: "grapes-shine",   name: "Shine Muscat Grapes", photo: commonsPhoto("Shine muscat (grape).jpg"), origin: "Japan",     price: 1299, unit: "500 g",     emoji: "🍇", tint: "#eef6e4", category: "Grapes", description: "Seedless green grapes with edible skin and a fragrant, muscat sweetness." },
  { id: "cherries",       name: "Cherries",          photo: commonsPhoto("Cherries.jpg"), origin: "USA",         price: 899, unit: "500 g",      emoji: "🍒", tint: "#fbe4e8", category: "Berries & Kiwi", description: "Dark, glossy sweet cherries from Washington orchards." },
  { id: "orange-navel",   name: "Navel Orange",      photo: commonsPhoto("Navel orange sectioned.jpg"), origin: "South Africa", price: 329, unit: "1 kg",      emoji: "🍊", tint: "#fff0de", category: "Citrus", description: "Seedless, easy-to-peel oranges bursting with bright, sweet juice." },
  { id: "mandarin",       name: "Mandarin",          photo: commonsPhoto("Mandarin Oranges (Citrus Reticulata).jpg"), origin: "Australia",   price: 379, unit: "1 kg",       emoji: "🍊", tint: "#fff3e3", category: "Citrus", description: "Small, sweet and aromatic, a lunchbox favourite." },
  { id: "passion-fruit",  name: "Passion Fruit",     photo: commonsPhoto("Passion fruits - whole and halved.jpg"), origin: "Kenya",       price: 449, unit: "pack of 6",  image: "images/passion-fruit.svg", tint: "#f3ece6", category: "Tropical", description: "Wrinkly outside, intensely fragrant tangy pulp inside." },
  { id: "pomelo",         name: "Pomelo",            photo: commonsPhoto("Pomelo fruit.jpg"), origin: "China",       price: 289, unit: "per piece",  image: "images/pomelo.svg", tint: "#eaf6ea", category: "Citrus", description: "The largest citrus fruit, with mild, sweet segments with no bitterness." },
  { id: "longan",         name: "Longan",            photo: commonsPhoto("Longan fruit flesh & skin.jpg"), origin: "Thailand",    price: 399, unit: "500 g",      image: "images/longan.svg", tint: "#f8f1df", category: "Tropical", description: "'Dragon eye' fruit with juicy, musky-sweet flesh. Peel and enjoy." },
  { id: "strawberry",     name: "Strawberries",      photo: commonsPhoto("Fresh strawberries.jpg"), origin: "Egypt",       price: 349, unit: "250 g box",  emoji: "🍓", tint: "#fde6ea", category: "Berries & Kiwi", description: "Bright red, fragrant strawberries, hand-packed to prevent bruising." },
];
