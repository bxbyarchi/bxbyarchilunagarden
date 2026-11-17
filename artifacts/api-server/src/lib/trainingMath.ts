/** Pure training rules: quiz validation and grading. */
export type Question = { q: string; options: string[]; correct: number };

export function validateQuiz(v: unknown): Question[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > 50) throw new Error("Неверный тест");
  return v.map((x, i) => {
    const q = String(x?.q ?? "").trim();
    const options = Array.isArray(x?.options) ? x.options.map((o: unknown) => String(o ?? "").trim()).filter(Boolean) : [];
    const correct = Number(x?.correct);
    if (!q) throw new Error(`Вопрос ${i + 1}: нет текста`);
    if (options.length < 2 || options.length > 6) throw new Error(`Вопрос ${i + 1}: нужно от 2 до 6 вариантов`);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new Error(`Вопрос ${i + 1}: отметьте правильный ответ`);
    return { q, options, correct };
  });
}

/** Score in %, which questions were wrong (indexes) — the right answers are not revealed. */
export function grade(quiz: Question[], answers: unknown, passPercent: number) {
  const a = Array.isArray(answers) ? answers.map((x) => (x == null ? -1 : Number(x))) : [];
  if (a.length !== quiz.length || a.some((x) => !Number.isInteger(x) || x < 0)) throw new Error("Ответьте на все вопросы");
  const wrong = quiz.map((q, i) => (a[i] === q.correct ? -1 : i)).filter((i) => i >= 0);
  const score = quiz.length ? Math.round(((quiz.length - wrong.length) / quiz.length) * 100) : 100;
  return { score, wrong, passed: score >= passPercent, answers: a };
}

/** The quiz as the learner sees it: no correct answers. */
export const publicQuiz = (quiz: Question[]) => quiz.map(({ q, options }) => ({ q, options }));
