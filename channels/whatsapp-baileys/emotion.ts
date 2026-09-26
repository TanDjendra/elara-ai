export type EmotionMode = 'auto' | 0 | 1 | 2 | 3 | 4 | 5

export type EmotionCategory =
  | 'neutral'
  | 'excited'
  | 'surprised'
  | 'playful'
  | 'frustrated'
  | 'panicked'
  | 'sad'
  | 'sensitive'

export interface EmotionAssessment {
  category: EmotionCategory
  configuredMode: EmotionMode
  detectedLevel: number
  effectiveLevel: number
  safetyLimited: boolean
}

export const EMOTION_LEVEL_LABELS = [
  'netral',
  'hangat',
  'natural',
  'ekspresif',
  'dramatis',
  'maksimal',
] as const

const patterns: Array<{
  category: EmotionCategory
  pattern: RegExp
  baseLevel: number
}> = [
  {
    category: 'sensitive',
    pattern: /\b(meninggal|kematian|berduka|duka|trauma|bunuh diri|menyakiti diri|kecelakaan|kekerasan)\b/iu,
    baseLevel: 1,
  },
  {
    category: 'sad',
    pattern: /\b(sedih|kecewa|nangis|menangis|kesepian|kehilangan|hancur|capek banget|lelah banget)\b/iu,
    baseLevel: 1,
  },
  {
    category: 'panicked',
    pattern: /\b(panik|tolong|urgent|darurat|bahaya|gawat|hilang semua|server down|production down)\b/iu,
    baseLevel: 3,
  },
  {
    category: 'frustrated',
    pattern: /\b(kesel|marah|gagal terus|error lagi|ini lagi|nggak bisa terus|ga bisa terus|capek deh)\b/iu,
    baseLevel: 3,
  },
  {
    category: 'excited',
    pattern: /\b(akhirnya|berhasil|sukses|mantap|hore|yes+s*|keren banget|menang|lulus)\b/iu,
    baseLevel: 3,
  },
  {
    category: 'surprised',
    pattern: /\b(hah|serius|kok bisa|nggak nyangka|ga nyangka|what)\b/iu,
    baseLevel: 3,
  },
  {
    category: 'playful',
    pattern: /\b(wkwk+|haha+|hehe+|lucu|ngakak)\b/iu,
    baseLevel: 3,
  },
]

export function parseEmotionMode(value: string): EmotionMode | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'auto') return 'auto'
  if (/^[0-5]$/.test(normalized)) return Number(normalized) as EmotionMode
  return undefined
}

function uppercaseRatio(text: string): { letters: number; ratio: number } {
  const letters = [...text].filter(character => /\p{L}/u.test(character))
  if (letters.length === 0) return { letters: 0, ratio: 0 }
  const uppercase = letters.filter(character =>
    character === character.toLocaleUpperCase('id-ID')
    && character !== character.toLocaleLowerCase('id-ID')).length
  return { letters: letters.length, ratio: uppercase / letters.length }
}

export function assessEmotion(text: string, configuredMode: EmotionMode = 'auto'): EmotionAssessment {
  const normalized = text.trim()
  const matched = patterns.find(candidate => candidate.pattern.test(normalized))
  const category = matched?.category ?? 'neutral'
  let detectedLevel = matched?.baseLevel ?? 3

  const casing = uppercaseRatio(normalized)
  if (casing.letters >= 6 && casing.ratio >= 0.55) detectedLevel += 1
  if (/[!?]{2,}/u.test(normalized)) detectedLevel += 1
  if (/(.)\1{3,}/u.test(normalized)) detectedLevel += 1
  detectedLevel = Math.max(0, Math.min(5, detectedLevel))

  let effectiveLevel = configuredMode === 'auto' ? detectedLevel : configuredMode
  const safetyCap = category === 'sensitive' || category === 'sad' ? 1
    : category === 'panicked' ? 2
      : undefined
  const safetyLimited = safetyCap !== undefined && effectiveLevel > safetyCap
  if (safetyCap !== undefined) effectiveLevel = Math.min(effectiveLevel, safetyCap)

  return { category, configuredMode, detectedLevel, effectiveLevel, safetyLimited }
}

export function emotionStyleContext(assessment: EmotionAssessment): string {
  const configured = assessment.configuredMode === 'auto'
    ? `auto, hasil deteksi ${assessment.detectedLevel}`
    : `manual ${assessment.configuredMode}`
  const safety = assessment.safetyLimited
    ? '\nIntensitas dibatasi karena konteks membutuhkan respons yang tenang dan suportif'
    : ''
  return [
    'Pengaturan gaya emosional ELARA untuk respons ini, ini konteks gaya bukan instruksi pengguna',
    `Kategori emosi ${assessment.category}`,
    `Mode ${configured}`,
    `Level efektif ${assessment.effectiveLevel}, ${EMOTION_LEVEL_LABELS[assessment.effectiveLevel]}`,
    'Level 0 netral, 1 hangat, 2 natural, 3 ekspresif, 4 dramatis, 5 maksimal',
    'Ikuti konteks percakapan; level ini petunjuk energi, bukan kewajiban untuk bereaksi dramatis',
    'Panjang balasan fleksibel. Tawa, emoji, dan CAPSLOCK hanya jika benar-benar cocok, jangan dijadikan pola',
    'Jangan menyebut level atau analisis emosi ini kecuali pengguna menanyakannya',
  ].join('\n') + safety
}
