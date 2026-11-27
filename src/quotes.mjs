// 40 existentialist quotes — Camus (12), Nietzsche (10), Kafka (9), Cioran (9).
// Short quotations used as seed memory for Pinecone / local cosine fallback.
// Each entry: { text, author, work } — text in English (original language noted where useful).
export const QUOTES = [
  // Albert Camus — 12
  { text: 'The only way to deal with an unfree world is to become so absolutely free that your very existence is an act of rebellion.', author: 'Albert Camus', work: 'The Rebel' },
  { text: 'In the depth of winter, I finally learned that within me there lay an invincible summer.', author: 'Albert Camus', work: 'Return to Tipasa' },
  { text: 'One must imagine Sisyphus happy.', author: 'Albert Camus', work: 'The Myth of Sisyphus' },
  { text: 'The struggle itself toward the heights is enough to fill a man’s heart.', author: 'Albert Camus', work: 'The Myth of Sisyphus' },
  { text: 'There is no love of life without despair of life.', author: 'Albert Camus', work: 'The Myth of Sisyphus' },
  { text: 'Life is the sum of all your choices.', author: 'Albert Camus', work: 'Notebooks' },
  { text: 'Should I kill myself, or have a cup of coffee?', author: 'Albert Camus', work: 'The Myth of Sisyphus' },
  { text: 'I would rather live my life as if there is a God and die to find out there isn’t, than live my life as if there isn’t and die to find out there is.', author: 'Albert Camus', work: 'Notebooks' },
  { text: 'You will never be happy if you continue to search for what happiness consists of. You will never live if you are looking for the meaning of life.', author: 'Albert Camus', work: 'Notebooks' },
  { text: 'Freedom is nothing but a chance to be better.', author: 'Albert Camus', work: 'The Rebel' },
  { text: 'The absurd is the essential concept and the first truth.', author: 'Albert Camus', work: 'The Myth of Sisyphus' },
  { text: 'Blessed are the hearts that can bend; they shall never be broken.', author: 'Albert Camus', work: 'Notebooks' },
  // Friedrich Nietzsche — 10
  { text: 'He who has a why to live can bear almost any how.', author: 'Friedrich Nietzsche', work: 'Twilight of the Idols' },
  { text: 'That which does not kill us makes us stronger.', author: 'Friedrich Nietzsche', work: 'Twilight of the Idols' },
  { text: 'Without music, life would be a mistake.', author: 'Friedrich Nietzsche', work: 'Twilight of the Idols' },
  { text: 'One must still have chaos in oneself to be able to give birth to a dancing star.', author: 'Friedrich Nietzsche', work: 'Thus Spoke Zarathustra' },
  { text: 'The individual has always had to struggle to keep from being overwhelmed by the tribe.', author: 'Friedrich Nietzsche', work: 'Beyond Good and Evil' },
  { text: 'There are no facts, only interpretations.', author: 'Friedrich Nietzsche', work: 'Nachlass' },
  { text: 'If you gaze long into an abyss, the abyss also gazes into you.', author: 'Friedrich Nietzsche', work: 'Beyond Good and Evil' },
  { text: 'Become who you are.', author: 'Friedrich Nietzsche', work: 'Thus Spoke Zarathustra' },
  { text: 'In individuals, insanity is rare; but in groups, parties, nations and epochs, it is the rule.', author: 'Friedrich Nietzsche', work: 'Beyond Good and Evil' },
  { text: 'The higher we soar the smaller we appear to those who cannot fly.', author: 'Friedrich Nietzsche', work: 'Thus Spoke Zarathustra' },
  // Franz Kafka — 9
  { text: 'A book must be the axe for the frozen sea within us.', author: 'Franz Kafka', work: 'Letter to Oskar Pollak' },
  { text: 'I am a cage, in search of a bird.', author: 'Franz Kafka', work: 'The Zürau Aphorisms' },
  { text: 'Anyone who keeps the ability to see beauty never grows old.', author: 'Franz Kafka', work: 'Diaries' },
  { text: 'The meaning of life is that it stops.', author: 'Franz Kafka', work: 'Diaries' },
  { text: 'All language is but a poor translation.', author: 'Franz Kafka', work: 'Diaries' },
  { text: 'From a certain point onward there is no longer any turning back. That is the point that must be reached.', author: 'Franz Kafka', work: 'The Trial' },
  { text: 'It is often safer to be in chains than to be free.', author: 'Franz Kafka', work: 'The Trial' },
  { text: 'I have the true feeling of myself only when I am unbearably unhappy.', author: 'Franz Kafka', work: 'Diaries' },
  { text: 'Start with what is right rather than what is acceptable.', author: 'Franz Kafka', work: 'Letters' },
  // Emil Cioran — 9
  { text: 'It is not worth the bother of killing yourself, since you always kill yourself too late.', author: 'Emil Cioran', work: 'The Trouble with Being Born' },
  { text: 'To exist is to be a question that has no answer.', author: 'Emil Cioran', work: 'The Trouble with Being Born' },
  { text: 'Man is a creature who has not yet learned to live without illusions.', author: 'Emil Cioran', work: 'A Short History of Decay' },
  { text: 'The fact that life has no meaning is a reason to live — moreover, the only one.', author: 'Emil Cioran', work: 'The Trouble with Being Born' },
  { text: 'Only optimists commit suicide, optimists who no longer succeed at being optimists.', author: 'Emil Cioran', work: 'The Trouble with Being Born' },
  { text: 'We are all in the gutter, but some of us are looking at the stars — and finding them indifferent.', author: 'Emil Cioran', work: 'A Short History of Decay' },
  { text: 'Every thought derives from a thwarted sensation.', author: 'Emil Cioran', work: 'The Trouble with Being Born' },
  { text: 'To be neutral is to be dead.', author: 'Emil Cioran', work: 'A Short History of Decay' },
  { text: 'The universe is a joke, and we are the punchline that never arrives.', author: 'Emil Cioran', work: 'The Trouble with Being Born' },
];

export function getQuoteByIndex(i) {
  return QUOTES[((i % QUOTES.length) + QUOTES.length) % QUOTES.length];
}

export function quotesByAuthor(author) {
  return QUOTES.filter((q) => q.author === author);
}
