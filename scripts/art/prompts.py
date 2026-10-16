"""What the model was asked for, for every piece of ECI Shuttle art. October 2026.

Each entry is the whole prompt, so a piece can be painted again or painted differently. Nothing here is a
secret. No picture carries lettering or a logo: any words are set by compose.py in Bricolage Grotesque.

Direction from Naman: painterly, whimsical, "gift wrap of whimsy", information stays simple. The vehicle is the
real one: an Indian Force/Mahindra Traveller-type 12-seater (tall white high-roof van), with a little Indian
vibe (marigold garland, truck-art flourish). Goan village road between Riva (beach) and Circle (co-work).
"""

STYLE = (
    "Loose painterly gouache illustration with visible brush strokes and soft paper texture, warm golden-hour "
    "light, a joyful, whimsical storybook feel, slightly naive hand-drawn shapes. Palette: warm cream, marigold "
    "orange, deep teal, palm green, laterite rust red, dusty pink and apricot sky. Absolutely no text, no letters, "
    "no numerals, no logos, no signboards with writing, no number plates with characters anywhere in the picture. "
    "The painting fills the whole canvas edge to edge: no white paper border, no frame, no vignette. "
)

VEHICLE = (
    "The shuttle is an Indian Force Traveller style minibus: a tall, boxy white high-roof 12-seater van with a "
    "big curved windscreen, round headlamps, a sliding side door, a row of side windows, a small roof carrier, "
    "a fresh orange marigold garland hung across the front grille, and a small painted folk-art flourish (lotus "
    "and vine swirls in teal and marigold, like Indian truck art) along its side. It looks friendly and cheerful. "
    "It is NOT a car, NOT a school bus, NOT a VW camper. The front grille is plain painted metal with no badge, no "
    "emblem and no brand name; the number plate is a plain blank painted rectangle; there is no lettering, no "
    "logo and no writing of any kind anywhere on the van. "
)

# A flat key colour that is cut out afterwards. The model is told twice because it matters.
KEY = (
    "The entire background is one flat, solid, uniform bright magenta colour, hex FF00FF, edge to edge, with no "
    "gradient, no texture, no shadow on it, no ground, no horizon and no vignette: the subject floats on plain "
    "magenta so it can be cut out. The subject itself must contain no magenta or pink. "
)

SUBJECTS = {
    # ---------------------------------------------------------------- hero scenes
    "hero-wide": {
        "aspect": "16:9",
        "prompt": STYLE
        + VEHICLE
        + "Scene: the shuttle van drives along a narrow coastal village road in Mandrem, Goa, between the beach "
        "and a co-working house. Golden hour. Tall coconut palms lean over the road, a low laterite stone wall, a "
        "small Goan house with a red tiled roof and a teal door, colourful bunting flags strung between two "
        "palms, a happy brown dog running alongside the van, a cow resting in the shade, a scooter parked by the "
        "wall, a fallen coconut on the verge, and a glimpse of the sea and beach in the distance on the left. "
        "Composition: the van sits in the lower right third of the picture, seen from a three-quarter front "
        "view. The upper left quarter of the picture is calm, open, softly painted sky and distant sea with very "
        "little detail, so a title can be placed there. Wide cinematic framing.",
    },
    "hero-tall": {
        "aspect": "3:4",
        "prompt": STYLE
        + VEHICLE
        + "Scene: the shuttle van drives along a narrow coastal village road in Mandrem, Goa, between the beach "
        "and a co-working house. Golden hour. Tall coconut palms lean in from the sides, a low laterite stone "
        "wall, a small Goan house with a red tiled roof, colourful bunting flags strung between palms, a happy "
        "brown dog running alongside the van, a fallen coconut on the verge, and a glimpse of the sea in the "
        "distance. Composition: the van sits in the lower half of the picture, seen from a three-quarter front "
        "view. The top third of the picture is calm, open, softly painted sky with very little detail, so a "
        "title can be placed there. Portrait framing.",
    },
    "scene-wide": {
        "aspect": "16:9",
        "prompt": STYLE
        + VEHICLE
        + "Scene: a calm, soft, hazy painting of the coastal village road in Mandrem, Goa, at golden hour, for "
        "use as a quiet page background: the shuttle van is small, far away on the road in the lower right, "
        "coconut palms, a laterite wall, a small house with a red tiled roof, bunting, the sea on the horizon. "
        "Everything is low contrast, muted and airy, like a faded gouache wash, with large calm areas of "
        "sky, and nothing sharp or busy, so text can be read on top of it. Wide cinematic framing.",
    },
    # ---------------------------------------------------------------- parallax layers (cut out by compose.py)
    "layer-sky": {
        "aspect": "16:9",
        "prompt": STYLE
        + "Only a sky: a soft golden-hour gouache sky over the Goan coast, apricot and dusty pink near the "
        "horizon fading to pale teal-blue above, a few loose soft clouds, a small warm sun low on the left, a "
        "couple of distant birds. No land, no sea, no trees, no objects at all, just sky, edge to edge.",
    },
    "layer-far": {
        "aspect": "16:9",
        "prompt": STYLE
        + "A distant-background layer for a parallax scene: a calm sea horizon with a pale beach, a low hazy "
        "headland with a soft silhouette of coconut palms, all in muted, hazy, low-contrast colours, occupying "
        "only the lower half of the picture. "
        + KEY
        + "Everything above the horizon and sea, the whole upper part of the picture, is flat solid magenta.",
    },
    "layer-mid": {
        "aspect": "16:9",
        "prompt": STYLE
        + "A middle-ground layer for a parallax scene: a loose row of tall coconut palms with leaning trunks, a "
        "low laterite stone wall, a small Goan house with a red tiled roof and a teal door, a string of "
        "colourful bunting flags between two palms, a resting cow, and a parked scooter, spread across the "
        "width, standing on an invisible ground line about one fifth from the bottom. "
        + KEY
        + "There is no ground, no road, no sky and no sea painted: between and above the palms, and below the "
        "ground line, the picture is flat solid magenta.",
    },
    "layer-road": {
        "aspect": "16:9",
        "prompt": STYLE
        + "A foreground layer for a parallax scene: a sandy laterite-red village road seen from the side, with "
        "a grassy verge, a few small stones, two fallen coconuts and a tuft of wild flowers, occupying only the "
        "bottom quarter of the picture with a soft uneven top edge. "
        + KEY
        + "Everything above the road, the whole upper three quarters of the picture, is flat solid magenta.",
    },
    "van-side": {
        "aspect": "3:2",
        "prompt": STYLE
        + VEHICLE
        + "Subject: the shuttle van alone, in a clean side view (profile, driving towards the left of the "
        "picture, front of the van on the left), wheels on an invisible ground line, filling most of the width "
        "with margin all round. A cheerful driver with a moustache is visible in the driver's window, one "
        "hand raised in a friendly wave. "
        + KEY,
    },
    "van-break": {
        "aspect": "3:2",
        "prompt": STYLE
        + VEHICLE
        + "Subject: the shuttle van alone, parked, in a clean side view (profile, front of the van on the "
        "left), wheels on an invisible ground line, filling most of the width with margin all round. The "
        "driver dozes in the driver's seat with his cap tipped over his eyes, and a small glass of chai sits "
        "on the dashboard by the windscreen. "
        + KEY,
    },
    "van-night": {
        "aspect": "3:2",
        "prompt": STYLE
        + VEHICLE
        + "Subject: the shuttle van alone, parked and asleep at night, in a clean side view (profile, front of "
        "the van on the left), wheels on an invisible ground line, filling most of the width with margin all "
        "round. It is lit by cool moonlight with deep blue shadows, its headlamps are drawn as two gently closed "
        "sleepy eyes, its windows are dark with the curtains drawn, and a small folded blanket rests on the "
        "roof carrier. Nobody is inside. "
        + KEY,
    },
    # ---------------------------------------------------------------- GIF backgrounds
    "bg-break": {
        "aspect": "16:9",
        "prompt": STYLE
        + "Scene, no vehicle and no people: a shady spot beside a Goan village road under one big leaning "
        "coconut palm, with a tiny roadside chai stall (a wooden cart with a steel kettle, a stack of small "
        "glasses, a hanging lantern, bunting), a laterite wall, flowering bougainvillea, and the sea far away "
        "to the left. Dappled afternoon light. The road and verge fill the bottom third of the picture and are "
        "empty, left clear for a parked van. No text, no signs.",
    },
    "bg-night": {
        "aspect": "16:9",
        "prompt": STYLE
        + "Scene, no vehicle and no people: a quiet Goan beach at night, a big friendly crescent moon and a "
        "few painted stars in a deep indigo and teal sky, the sea calm with a soft moon path, two silhouetted "
        "coconut palms, a sandy road along the beach filling the bottom third of the picture, empty, left "
        "clear for a parked van. Cosy, gentle, sleepy mood. No text, no signs.",
    },
}
