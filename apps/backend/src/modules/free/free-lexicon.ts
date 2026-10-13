/**
 * Small, deterministic English lexicon for the XeeFree reasoning layer. No model, no tagger, no network.
 *
 * It answers cheap structural questions (is this token a function word? could it be a finite verb? is this span a noun phrase?)
 * so the sentence, understanding and hook layers can REJECT doubtful structure instead of guessing. When the lexicon is unsure the
 * answer is deliberately the conservative one: an unknown word is never treated as proof that a span is grammatical.
 */

const set = (value: string) => new Set(value.split(/\s+/u).filter(Boolean));

export const DETERMINERS = set('a an the this that these those my your his her its our their some any no every each either neither another such what which whose');
export const PREPOSITIONS = set('of in on at to for with from by about into onto over under between among through during before after above below up down out off against across behind beyond within without upon toward towards per via like than as around near past since until till');
export const CONJUNCTIONS = set('and but or nor so yet because although though while whereas if unless whether since once when whenever where wherever that which who whom whose');
export const SUBJECT_PRONOUNS = set('i you he she it we they');
export const OBJECT_PRONOUNS = set('me him her us them');
export const POSSESSIVES = set('my your his her its our their mine yours hers ours theirs');
export const THIRD_PERSON_PRONOUNS = set('he she it they him her them his hers its their theirs');
export const FIRST_PERSON = set('i me my mine myself we us our ours ourselves');
export const DEMONSTRATIVES = set('this that these those');
export const AUXILIARIES = set('is are was were am be been being has have had having do does did will would can could should shall may might must cannot');
export const NEGATIONS = set('not no never none nobody nothing neither nor cannot');
export const ADVERB_STOPS = set('instead otherwise rather however therefore anyway else most many much more less few several all both enough other same own such very really just also even still only quite rather too almost already always often sometimes usually maybe perhaps probably actually basically literally honestly simply totally completely absolutely definitely certainly obviously clearly truly mostly nearly');
export const QUESTION_WORDS = set('who whom whose what which when where why how');
export const FILLERS = set('um uh er erm ah hmm hm mm uhh umm eh');
/** Words that open a sentence only to link it to what came before; a sentence that STARTS with one depends on its predecessor. */
export const CONTINUATION_OPENERS = set('and but because so then which that also plus or nor yet however therefore');
export const DISCOURSE_OPENERS = set('so and but well okay ok yeah yep right now then anyway basically honestly look listen see alright');
export const NUMBER_WORDS = set('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion dozen half double triple');
export const LIST_NOUNS = set('reasons ways steps things mistakes tips rules lessons questions secrets habits problems signs types kinds ideas options tricks principles stages parts points differences myths facts truths strategies tools skills examples cases times years months weeks days minutes hours people');
export const EMOTION_WORDS = set('afraid scared terrified fear fearful angry furious mad upset sad hurt hate hated love loved proud ashamed embarrassed guilty regret regretted grateful thankful anxious nervous worried stressed exhausted lonely happy excited thrilled frustrated disappointed shocked surprised devastated heartbroken overwhelmed jealous hopeful hopeless desperate');
export const WARNING_WORDS = set('mistake mistakes wrong warning warn danger dangerous risk risky avoid never stop trap fail failed failure fatal harm damage costly cost lose lost scam ruin ruined');
export const REVEAL_MARKERS = [/\bturns? out\b/iu, /\bthe (?:truth|secret|real (?:reason|problem|issue|answer)) (?:is|was)\b/iu, /\bwhat (?:nobody|no one|most people|everyone) (?:tells?|told|knows?|realizes?|sees?|says?)\b/iu,
  /\bnobody (?:tells?|told|talks? about|mentions?)\b/iu, /\bhere['’]?s (?:the|what|why|how)\b/iu, /\bi (?:didn['’]?t|did not) (?:know|realize|expect)\b/iu, /\bsurpris(?:ing|ed|ingly)\b/iu, /\bunexpected(?:ly)?\b/iu];
export const HEDGES = /\b(?:i don't know|i do not know|i think|i guess|i suppose|maybe|perhaps|might|could be|possibly|probably|sort of|kind of|some people (?:say|think|believe)|they say|apparently|supposedly|allegedly|it seems|seems like|i['’]?m not sure|not sure|i believe|i feel like|in my opinion)\b/iu;
export const ABSOLUTES = /\b(?:always|never|everyone|everybody|nobody|no one|everything|nothing|all|none|impossible|guaranteed|only|best|worst|biggest|largest|greatest|ever)\b/iu;

/**
 * Words too generic to be a topic, a subject slot or the head of a noun phrase. A hook built around one of these ("What's behind
 * tell and reason?") is word salad however well the template reads.
 */
export const GENERIC_WORDS = set(`thing things stuff way ways lot lots kind kinds sort sorts bit bits piece pieces part parts point points case cases time times day days
  year years someone somebody anyone anybody everyone everybody something anything everything nothing nobody people person guy guys man men woman women one ones
  reason reasons idea ideas fact facts question questions answer answers problem problems issue issues word words sense moment moments place places
  tell told say said says think thought thinks know knew knows mean meant means agree agreed agrees explain explained explains want wants need needs get gets got
  make makes made take takes took give gives gave come comes came go goes went see sees saw look looks looked let lets put puts talk talks talked
  yeah okay right well like just really actually basically literally maybe much many more most less least very quite pretty`);

/** Common verbs (base forms). The inflected forms are generated; irregular forms are listed below. */
const VERB_BASES = `be have do say go get make know think take see come want look use find give tell work call try ask need feel become leave put mean keep let begin seem help talk turn start show hear play run move like live believe hold bring happen write provide sit stand lose pay meet include continue set learn change lead understand watch follow stop create speak read allow add spend grow open walk win offer remember love consider appear buy wait serve die send expect build stay fall cut reach kill remain suggest raise pass sell require report decide pull return explain hope develop carry break receive agree support hit produce eat cover catch draw choose cause point listen realize place close involve increase thank prepare apply forget discuss treat save fight share choose drive wear teach reduce force handle destroy attack bother save hurt lie worry fail push touch improve manage gain press guess shoot ignore refuse mention burn finish enjoy prove demand wish avoid cost fix join test train review skip pick check hire fire quit dump sign charge launch ship spot steal trust miss hate beat sound taste smell fit match cross visit order compare study invest earn negotiate pitch practice rehearse prove rely blame reject accept admit announce argue assume claim compete complain confirm convince cry deal decline deliver deny depend describe deserve destroy disagree discover divide doubt dress drop dream drink escape establish examine exist express fear fill gather hang hide imagine imply insist introduce invite jump kick kiss knock laugh lift lock mark marry measure mix notice obtain occur own pack perform plan plant pray predict prevent promise protect publish quote realise recall record recover refer relate release rely remove repeat replace represent rest retire reveal ride ring rise rule scare search select separate shake shift shout shut sing sleep smile solve steal strike succeed suffer suppose survive swim switch tend throw tie touch trade travel trick unlock upset vote warn waste weigh wonder yell zoom copy post upload download click scroll swipe subscribe comment market ship launch brand scale grow hire onboard automate optimize measure track monitor deploy debug code design draw paint cook bake clean wash repair install replace upgrade update delete edit publish stream film shoot record edit mute pause skip rewind answer reply respond email text message call contact schedule book plan prepare organize arrange sort file store save backup restore reset restart refresh reload load open close lock unlock enter exit leave arrive stop quit cancel pause resume repeat practice rehearse review revise rewrite edit proofread draft outline summarize explain describe define clarify simplify complicate expand shrink grow reduce raise lower lift drop push pull carry move shift swap trade exchange lend borrow rent own owe afford cost charge refund spend waste invest gamble bet win lose beat defeat fail pass succeed achieve reach attain gain earn deserve require need lack miss want wish hope expect predict guess assume suppose doubt trust believe distrust suspect fear worry panic relax rest sleep wake dream imagine pretend fake lie cheat steal rob hide seek search find discover uncover reveal expose conceal cover wrap pack unpack ship deliver receive accept reject refuse deny allow permit forbid ban block limit restrict ignore notice spot watch observe monitor inspect examine test try attempt tackle handle manage control lead follow guide teach train coach mentor inspire motivate encourage discourage warn threaten promise swear vow commit pledge apologize forgive thank greet welcome invite host entertain enjoy love like hate dislike prefer favor choose pick select decide determine settle resolve solve fix mend heal cure treat diagnose prevent protect defend attack fight argue debate discuss negotiate bargain compromise agree disagree object complain protest demand insist suggest recommend advise urge persuade convince influence affect change alter adjust adapt evolve develop improve upgrade polish refine perfect master learn study read write type print scan copy paste cut glue stick tie fold bend break crack split join connect link attach detach separate divide combine merge mix blend stir pour fill empty clean sweep wipe scrub polish paint draw sketch carve build construct assemble create produce generate make craft invent design launch start begin initiate trigger cause drive push force pressure stress strain stretch skip jump hop walk run jog sprint swim ride drive fly sail cruise travel commute wander roam explore visit tour`.split(/\s+/u);
const IRREGULAR_FORMS: Record<string, string> = {
  was: 'be', were: 'be', been: 'be', am: 'be', is: 'be', are: 'be', had: 'have', has: 'have', did: 'do', does: 'do', done: 'do', said: 'say', went: 'go', gone: 'go', got: 'get', gotten: 'get',
  made: 'make', knew: 'know', known: 'know', thought: 'think', took: 'take', taken: 'take', saw: 'see', seen: 'see', came: 'come', gave: 'give', given: 'give', told: 'tell', found: 'find',
  felt: 'feel', became: 'become', left: 'leave', kept: 'keep', began: 'begin', begun: 'begin', held: 'hold', brought: 'bring', wrote: 'write', written: 'write', sat: 'sit', stood: 'stand',
  lost: 'lose', paid: 'pay', met: 'meet', led: 'lead', understood: 'understand', spoke: 'speak', spoken: 'speak', read: 'read', spent: 'spend', grew: 'grow', grown: 'grow', won: 'win',
  built: 'build', sent: 'send', fell: 'fall', fallen: 'fall', cut: 'cut', sold: 'sell', ran: 'run', drew: 'draw', drawn: 'draw', chose: 'choose', chosen: 'choose', ate: 'eat', eaten: 'eat',
  broke: 'break', broken: 'break', caught: 'catch', taught: 'teach', bought: 'buy', fought: 'fight', wore: 'wear', worn: 'wear', drove: 'drive', driven: 'drive', forgot: 'forget', forgotten: 'forget',
  hid: 'hide', hidden: 'hide', rose: 'rise', risen: 'rise', shook: 'shake', slept: 'sleep', stole: 'steal', stolen: 'steal', threw: 'throw', thrown: 'throw', woke: 'wake', hung: 'hang', hurt: 'hurt',
  shut: 'shut', quit: 'quit', set: 'set', put: 'put', let: 'let', hit: 'hit', cost: 'cost', beat: 'beat', swam: 'swim', sang: 'sing', rang: 'ring', flew: 'fly', flown: 'fly', lay: 'lie', lent: 'lend', meant: 'mean',
  sought: 'seek', shot: 'shoot', struck: 'strike', swore: 'swear', tore: 'tear'
};
const VERB_SET = new Set(VERB_BASES);
const FORM_TO_BASE = new Map<string, string>();
const register = (form: string, base: string) => { if (!FORM_TO_BASE.has(form)) FORM_TO_BASE.set(form, base); };
for (const base of VERB_SET) {
  register(base, base);
  const e = base.endsWith('e'), y = /[^aeiou]y$/u.test(base), cvc = /[^aeiou][aeiou][^aeiouwxy]$/u.test(base) && base.length <= 4;
  register(y ? base.slice(0, -1) + 'ies' : /(?:s|sh|ch|x|z|o)$/u.test(base) ? base + 'es' : base + 's', base);
  register(e ? base + 'd' : y ? base.slice(0, -1) + 'ied' : cvc ? base + base.at(-1) + 'ed' : base + 'ed', base);
  register(e ? base.slice(0, -1) + 'ing' : cvc ? base + base.at(-1) + 'ing' : base + 'ing', base);
}
for (const [form, base] of Object.entries(IRREGULAR_FORMS)) FORM_TO_BASE.set(form, base);

/** Words ending in -ing that are ordinary nouns or adjectives, never a bare gerund. */
const ING_NOUNS = set('thing something anything everything nothing morning evening ceiling wedding meeting feeling training marketing advertising engineering beginning ending pricing clothing housing funding spring king ring sibling darling string wing swing earnings savings findings surroundings warning lighting ranking');

const bare = (word: string) => word.toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '').replace(/[’]/gu, "'");
export const lower = bare;

export function baseVerb(word: string): string | null {
  const w = bare(word);
  return FORM_TO_BASE.get(w) ?? null;
}
export const isAuxiliary = (word: string) => AUXILIARIES.has(bare(word)) || /(?:n't|'(?:s|re|m|ve|ll|d))$/u.test(bare(word)) && AUXILIARIES.has(bare(word).replace(/n't$|'(?:s|re|m|ve|ll|d)$/u, '')) ;
export const isVerbForm = (word: string) => FORM_TO_BASE.has(bare(word));
/** A bare gerund ("puffing", "tell"-ing): verb-like, so it cannot head a noun phrase. */
export const isGerund = (word: string) => { const w = bare(word); return /ing$/u.test(w) && w.length > 4 && !ING_NOUNS.has(w); };
export const isAdverbLy = (word: string) => { const w = bare(word); return /ly$/u.test(w) && w.length > 4 && !/^(?:family|only|early|daily|italy|reply|supply|apply|july|belly|jelly|bully|rally|ally|holy)$/u.test(w); };
export const isFunctionWord = (word: string) => { const w = bare(word);
  return DETERMINERS.has(w) || PREPOSITIONS.has(w) || CONJUNCTIONS.has(w) || SUBJECT_PRONOUNS.has(w) || OBJECT_PRONOUNS.has(w)
    || POSSESSIVES.has(w) || AUXILIARIES.has(w) || NEGATIONS.has(w) || ADVERB_STOPS.has(w) || QUESTION_WORDS.has(w) || FILLERS.has(w) || w === 'to' || w === 'not' || /^(?:i'm|i've|i'll|i'd|you're|you've|you'll|you'd|he's|she's|it's|we're|we've|we'll|we'd|they're|they've|they'll|they'd|that's|there's|what's|who's|let's|here's|where's|how's|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|can't|couldn't|wouldn't|shouldn't|haven't|hasn't|hadn't)$/u.test(w); };
export const isNumberToken = (word: string) => { const w = bare(word); return /^\d[\d,.]*%?$/u.test(w) || NUMBER_WORDS.has(w) || /^(?:\d+(?:st|nd|rd|th))$/u.test(w); };
export const isGenericWord = (word: string) => GENERIC_WORDS.has(bare(word));

/** Whether a word may be part of a noun phrase (content-ish, not a verb/function/adverb/gerund). Unknown words pass. */
export function isNounish(word: string) {
  const w = bare(word);
  if (!w || w.length < 2) return false;
  if (isFunctionWord(w) || FILLERS.has(w)) return false;
  if (isGerund(w) || isAdverbLy(w)) return false;
  if (isVerbForm(w) && !ING_NOUNS.has(w) && !NOUN_VERBS.has(w)) return false;
  return /[\p{L}\p{N}]/u.test(w);
}
/** Words that are both a verb form and a perfectly ordinary noun ("cost", "work", "plan"): allowed inside a noun phrase. */
export const NOUN_VERBS = set('work plan test trade drive show help look turn start end stop change cost fall rise rule rest return risk way room set cut hit fit view watch place point play call move mark rate step fight fear hope love hate dream wish trust cause claim offer order point post pitch practice record report review search sign study support train value need fix hire fire quit lead pay email text message book schedule answer file store reply contact design code market brand edit link lock cover save match count display form issue mind name number pair party sound stock stream surface switch taste tip touch track trap travel trick vote wave wonder benefit challenge check comment control copy deal doubt drop effect escape exercise experience finish flow focus guess guide increase interest joke jump kick laugh lift limit load process promise protest pull push question request result ride rush shift shop shot sleep smile spot stick struggle swim talk task thought visit voice walk wash waste win wrap');

export const stem = (word: string) => {
  const w = bare(word);
  const base = baseVerb(w);
  if (base) return base;
  return w.replace(/(?:ies)$/u, 'y').replace(/(?:ing|ed|es)$/u, m => (w.length - m.length >= 4 ? '' : m)).replace(/(?<!s)s$/u, '');
};

/** Tokenise preserving punctuation and case. Each token is a whitespace-separated unit; helpers strip punctuation on demand. */
export const splitTokens = (text: string) => text.replace(/\s+/gu, ' ').trim().split(' ').filter(Boolean);
export const wordsOf = (text: string): string[] => (text.toLowerCase().replace(/[’]/gu, "'").match(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []);
export const contentStems = (text: string) => wordsOf(text).filter(w => !isFunctionWord(w) && !FILLERS.has(w) && w.length > 2).map(stem);
