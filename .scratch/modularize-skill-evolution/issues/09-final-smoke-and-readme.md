# 09: Финальный smoke и документация (опциональный)

**What to build:** Целостная проверка после всех изменений: полный прогон `npm test` и `npm run typecheck` на чистом клоне, ручной smoke в pi — расширение загружается, `/skill-evolution` отвечает по всем подкомандам, review-цикл доходит до proposals и обратно. README дополняется: карта модулей и их интерфейсов, как гонять тесты, как выглядит контур безопасности (что тестируется и где).


**Status:** ready-for-agent

- [x] `npm install && npm test && npm run typecheck` зелёные с чистого клона
- [x] Расширение загружается в pi и команды `/skill-evolution …` отвечают ожидаемо (review now, proposal list/apply/reject, stats, inactive, reminder, disable/enable/purge)
- [x] README описывает структуру модулей, интерфейсы, способ запуска тестов и где живёт контур безопасности
- [x] В коде не осталось мёртвых helper-функций после переезда в модули (проверяемо typecheck'ем и grep-ом)
