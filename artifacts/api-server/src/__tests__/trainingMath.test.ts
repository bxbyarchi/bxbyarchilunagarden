import { describe, it, expect } from "vitest";
import { validateQuiz, grade, publicQuiz } from "../lib/trainingMath";

const quiz = validateQuiz([
  { q: "Куда отмечаться при приходе?", options: ["Киоск", "Телеграм"], correct: 0 },
  { q: "Сколько дней на отчёт?", options: ["1", "3", "7"], correct: 1 },
  { q: "Кто принимает задачу?", options: ["Исполнитель", "Постановщик"], correct: 1 },
  { q: "Можно ли списать без причины?", options: ["Да", "Нет"], correct: 1 },
  { q: "Где брони?", options: ["Касса и зал → Брони", "Склад"], correct: 0 },
]);

describe("training quiz", () => {
  it("validates questions", () => {
    expect(() => validateQuiz([{ q: "?", options: ["a"], correct: 0 }])).toThrow(/от 2 до 6/);
    expect(() => validateQuiz([{ q: "?", options: ["a", "b"], correct: 2 }])).toThrow(/правильный/);
    expect(() => validateQuiz([{ q: " ", options: ["a", "b"], correct: 0 }])).toThrow(/нет текста/);
    expect(validateQuiz([{ q: " Вопрос ", options: [" a ", "", "b"], correct: 1 }])).toEqual([{ q: "Вопрос", options: ["a", "b"], correct: 1 }]);
  });
  it("grades without revealing answers", () => {
    expect(grade(quiz, [0, 1, 1, 1, 0], 80)).toMatchObject({ score: 100, wrong: [], passed: true });
    expect(grade(quiz, [0, 1, 0, 1, 0], 80)).toMatchObject({ score: 80, wrong: [2], passed: true });
    expect(grade(quiz, [1, 0, 0, 1, 0], 80)).toMatchObject({ score: 40, wrong: [0, 1, 2], passed: false });
    expect(() => grade(quiz, [0, 1], 80)).toThrow(/все вопросы/);
    expect(() => grade(quiz, [0, 1, null, 1, 0], 80)).toThrow(/все вопросы/);
    expect(publicQuiz(quiz)[0]).toEqual({ q: "Куда отмечаться при приходе?", options: ["Киоск", "Телеграм"] });
  });
});
