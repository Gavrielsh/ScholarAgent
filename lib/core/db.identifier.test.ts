import { assertSqlIdentifier } from "@/lib/core/db";

/**
 * `SET LOCAL ROLE` cannot bind its argument as a parameter, so the role name is
 * interpolated into SQL. This validator is the only thing between the
 * PG_APP_ROLE environment variable and arbitrary statements, which is why it is
 * tested directly instead of only through a path that needs a database.
 */
describe("assertSqlIdentifier", () => {
  it("accepts the default application role", () => {
    expect(assertSqlIdentifier("scholaragent_app", "PG_APP_ROLE")).toBe("scholaragent_app");
  });

  it("accepts the characters PostgreSQL allows unquoted", () => {
    for (const name of ["_role", "Role1", "a$b", "A_b$C9"]) {
      expect(assertSqlIdentifier(name, "src")).toBe(name);
    }
  });

  it("rejects a statement terminator, which is the injection case", () => {
    expect(() => assertSqlIdentifier("app; DROP TABLE users", "PG_APP_ROLE")).toThrow(
      /not a plain SQL identifier/
    );
  });

  it("rejects quotes, whitespace, comments and parentheses", () => {
    for (const bad of [
      'app"',
      "app'",
      "app role",
      "app--comment",
      "app/*c*/",
      "app()",
      "app,other",
      "app\nrole",
    ]) {
      expect(() => assertSqlIdentifier(bad, "src")).toThrow(/not a plain SQL identifier/);
    }
  });

  it("rejects a leading digit and an empty name", () => {
    expect(() => assertSqlIdentifier("1role", "src")).toThrow();
    expect(() => assertSqlIdentifier("", "src")).toThrow();
  });

  it("names the source in the message so the misconfiguration is findable", () => {
    expect(() => assertSqlIdentifier("bad name", "PG_APP_ROLE")).toThrow(/PG_APP_ROLE/);
  });
});
