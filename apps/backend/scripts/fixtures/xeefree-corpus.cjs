// XeeFree acceptance corpus: spoken-style transcripts for every content type the free pipeline must handle.
// Disposable and synthetic. verify-xeefree-live.cjs separately records synthetic spoken fixtures and authorised real English media.
// `turns` carry diarization-style speaker labels; a monologue uses one label.
module.exports = [
  { id: 'A-question-answer', kind: 'clear question/answer', turns: [
    ['host', 'Why do most people struggle to stay consistent with exercise?'],
    ['guest', 'Because they rely on motivation instead of routine. Motivation fades after two weeks, but a routine keeps going when you are tired. So the real fix is to make the workout so small that skipping it feels silly.']] },
  { id: 'B-story', kind: 'story', turns: [
    ['speaker', 'Three years ago I lost my biggest client overnight. I remember sitting in my car, staring at an invoice that would never be paid. After losing that client I called every old friend in my network. One of them offered me a project the next morning, and that project turned into my entire business.']] },
  { id: 'C-advice', kind: 'advice', turns: [
    ['speaker', 'Never answer email first thing in the morning. You should spend the first hour on the one task that moves your work forward. Email feels productive, but it only answers other people\'s priorities.']] },
  { id: 'D-disagreement', kind: 'disagreement', turns: [
    ['a', 'Remote work kills creativity because people stop bumping into each other.'],
    ['b', 'I disagree. Our best ideas came from written proposals that everyone could read at their own pace. Creativity needs time to think, not a shared hallway.']] },
  { id: 'E-two-speakers', kind: 'two speakers', turns: [
    ['host', 'What was the hardest part of building the company?'],
    ['guest', 'Hiring too fast. We hired twenty people in three months and lost our culture. The lesson is to hire slowly and fire quickly.']] },
  { id: 'G-list', kind: 'list', turns: [
    ['speaker', 'There are three reasons startups fail. First, they build something nobody wants. Second, they run out of cash before they find customers. Third, the founders stop trusting each other.']] },
  { id: 'H-tutorial', kind: 'tutorial/screen recording', sceneType: 'screen recording', turns: [
    ['narrator', 'Open the Settings app and select Keyboard. Choose Shortcuts and search for the action you use most often. Assign a key combination that does not conflict with another command. Save the shortcut and test it before closing Settings.']] },
  { id: 'I-monologue', kind: 'longer monologue', turns: [
    ['speaker', 'Learning to code is mostly learning to be confused productively. Beginners think confusion means they are bad at it. The opposite is true, because confusion is the moment your model of the problem is being corrected. Every experienced engineer has spent hours stuck on a bug that turned out to be one wrong character. What separates them is not talent but a habit of shrinking the problem. They delete code until the bug has nowhere to hide. Then they add it back one piece at a time. This sounds slow, but it is faster than staring at a thousand lines. The skill you are really building is patience with your own ignorance.']] },
  { id: 'J-hindi', kind: 'Hindi', language: 'hi', turns: [
    ['speaker', 'हर किसी की पसंद बनने की कोशिश में अपनी सीमाएं भूलना आसान है। जब मैंने हर अनुरोध पर हां कहना बंद किया तो अपने काम के लिए समय मिला। दूसरों की नाराजगी स्वीकार करना भी जरूरी है।']] },
  { id: 'K-hinglish', kind: 'Hinglish', language: 'hinglish', turns: [
    ['speaker', 'Har kisi ko impress karna zaroori nahi hai. Jab maine boundaries set ki tab apne focused work ke liye time mila. Approval ke peeche bhaagne se better hai apni priorities clear rakhna.']] }
];
