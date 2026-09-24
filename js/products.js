/*
 * Product catalogue. Each product shows either `image` (a path or URL;
 * swap in real product photos here) or, if no image is set, `emoji`,
 * on a `tint` background.
 */
window.PRODUCTS = [
  { id: "dragon-fruit",   name: "Dragon Fruit",      origin: "Vietnam",     price: 249, unit: "per piece",  image: "images/dragon-fruit.svg", tint: "#fde7f0", category: "Tropical", description: "Mildly sweet white flesh speckled with seeds, wrapped in a vivid pink skin." },
  { id: "avocado-hass",   name: "Hass Avocado",      origin: "Mexico",      price: 399, unit: "pack of 3",  emoji: "🥑", tint: "#eaf5e1", category: "Tropical", description: "Creamy, buttery avocados picked at peak maturity. Ripen at room temperature." },
  { id: "kiwi-gold",      name: "Golden Kiwi",       origin: "New Zealand", price: 349, unit: "pack of 6",  emoji: "🥝", tint: "#f4f7dc", category: "Berries & Kiwi", description: "Smooth-skinned kiwi with sweet, tropical golden flesh and low acidity." },
  { id: "blueberries",    name: "Blueberries",       origin: "Peru",        price: 299, unit: "125 g box",  emoji: "🫐", tint: "#e6ebfa", category: "Berries & Kiwi", description: "Plump, dusty-blue berries, perfect for breakfast bowls and baking." },
  { id: "mangosteen",     name: "Mangosteen",        origin: "Thailand",    price: 699, unit: "500 g",      image: "images/mangosteen.svg", tint: "#efe6f5", category: "Tropical", description: "The 'queen of fruits': juicy, tangy-sweet segments under a deep purple rind." },
  { id: "rambutan",       name: "Rambutan",          origin: "Malaysia",    price: 549, unit: "500 g",      image: "images/rambutan.svg", tint: "#fde8e4", category: "Tropical", description: "Hairy red shell hiding translucent, lychee-like flesh with a floral finish." },
  { id: "apple-fuji",     name: "Fuji Apple",        origin: "Japan",       price: 459, unit: "pack of 4",  emoji: "🍎", tint: "#fdeaea", category: "Orchard", description: "Crisp, dense and honey-sweet. A premium dessert apple with a long shelf life." },
  { id: "pear-korean",    name: "Korean Pear",       origin: "South Korea", price: 499, unit: "pack of 2",  emoji: "🍐", tint: "#f5f3dc", category: "Orchard", description: "Large, round and incredibly juicy with a crunchy, refreshing bite." },
  { id: "grapes-shine",   name: "Shine Muscat Grapes", origin: "Japan",     price: 1299, unit: "500 g",     emoji: "🍇", tint: "#eef6e4", category: "Grapes", description: "Seedless green grapes with edible skin and a fragrant, muscat sweetness." },
  { id: "cherries",       name: "Cherries",          origin: "USA",         price: 899, unit: "500 g",      emoji: "🍒", tint: "#fbe4e8", category: "Berries & Kiwi", description: "Dark, glossy sweet cherries from Washington orchards." },
  { id: "orange-navel",   name: "Navel Orange",      origin: "South Africa", price: 329, unit: "1 kg",      emoji: "🍊", tint: "#fff0de", category: "Citrus", description: "Seedless, easy-to-peel oranges bursting with bright, sweet juice." },
  { id: "mandarin",       name: "Mandarin",          origin: "Australia",   price: 379, unit: "1 kg",       emoji: "🍊", tint: "#fff3e3", category: "Citrus", description: "Small, sweet and aromatic, a lunchbox favourite." },
  { id: "passion-fruit",  name: "Passion Fruit",     origin: "Kenya",       price: 449, unit: "pack of 6",  image: "images/passion-fruit.svg", tint: "#f3ece6", category: "Tropical", description: "Wrinkly outside, intensely fragrant tangy pulp inside." },
  { id: "pomelo",         name: "Pomelo",            origin: "China",       price: 289, unit: "per piece",  image: "images/pomelo.svg", tint: "#eaf6ea", category: "Citrus", description: "The largest citrus fruit, with mild, sweet segments with no bitterness." },
  { id: "longan",         name: "Longan",            origin: "Thailand",    price: 399, unit: "500 g",      image: "images/longan.svg", tint: "#f8f1df", category: "Tropical", description: "'Dragon eye' fruit with juicy, musky-sweet flesh. Peel and enjoy." },
  { id: "strawberry",     name: "Strawberries",      origin: "Egypt",       price: 349, unit: "250 g box",  emoji: "🍓", tint: "#fde6ea", category: "Berries & Kiwi", description: "Bright red, fragrant strawberries, hand-packed to prevent bruising." },
];
