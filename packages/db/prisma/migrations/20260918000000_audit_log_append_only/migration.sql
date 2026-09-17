-- Защита журнала аудита от изменения и удаления (ТЗ п. 2.7).
--
-- Приложение никогда не правит и не удаляет записи аудита — проверено
-- (`auditLog.update/delete` не встречаются в коде). Но это гарантия уровня
-- приложения: любой, кто подключится к БД напрямую (или будущая ошибка в
-- коде), сможет подделать историю операций. Журнал, который можно изменить,
-- не является доказательством.
--
-- Почему триггер, а не REVOKE:
-- приложение подключается пользователем-владельцем таблицы, а владелец
-- обходит проверки прав. `REVOKE UPDATE, DELETE` заблокировал бы всех, кроме
-- того, кто и должен быть ограничен. Триггер срабатывает независимо от роли.
--
-- Аварийный выход для очистки тестовых данных (требование заказчика:
-- вычистить тестовые данные при переключении в продакшн) оставлен осознанно:
-- он доступен только при явно выставленном флаге сессии, то есть требует
-- намеренного действия, а не случая. Обычная очистка запрещена.

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  -- Единственный разрешённый путь: скрипт очистки тестовых данных
  -- (scripts/purge-test-data.mjs) выставляет флаг в своей транзакции.
  IF current_setting('app.allow_audit_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'Журнал аудита защищён от изменения и удаления (append-only)'
    USING ERRCODE = 'restrict_violation',
          HINT = 'Записи аудита неизменяемы. Для очистки тестовых данных используйте scripts/purge-test-data.mjs';
END;
$$ LANGUAGE plpgsql;

-- UPDATE и DELETE — построчно.
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- TRUNCATE не проходит через построчный триггер, поэтому нужен отдельный
-- операторный: иначе журнал можно было бы очистить одной командой.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
