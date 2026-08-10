import { Kysely, sql } from 'kysely'
import type { RelationalDatabase } from './Flavour.js'
import { NodeSqliteDialect } from './NodeSqlite.js'

/**
 * A small database with one of everything the translation has to get right.
 *
 * In memory and over `node:sqlite`, so the whole suite runs with no server and no native module -
 * which is the property the conformance work (DEV-440) needs, since a suite that skips itself when
 * a database is missing reports green having tested nothing.
 *
 * The data is chosen for the disagreements rather than for realism. `borg` and `Borg AB` differ
 * only in case, because case-sensitivity is the divergence that silently changes what a search box
 * finds. `city` is null on one row, because `ne` matching a row that has no value is the rule SQL
 * does not follow on its own. `tags` and `notes` exist to be *refused*: one has a composite key and
 * the other has none, and both must be reported rather than quietly missing.
 */
export const fixture = async (): Promise<Kysely<RelationalDatabase>> => {
    const db = new Kysely<RelationalDatabase>({ dialect: new NodeSqliteDialect({ filename: ':memory:' }) })

    await sql`create table customers (
        id integer primary key,
        name text not null,
        city text,
        active boolean,
        balance real
    )`.execute(db)
    await sql`insert into customers (id, name, city, active, balance) values
        (1, 'Acme Ltd', 'Berlin', 1, 12.5),
        (2, 'borg', null, 0, 3.0),
        (3, 'Borg AB', 'Malmo', 1, 40.0),
        (4, 'Cyberdyne', 'Berlin', null, null)`.execute(db)

    await sql`create table orders (
        id integer primary key,
        customer_id integer not null,
        total real
    )`.execute(db)
    await sql`insert into orders (id, customer_id, total) values
        (10, 1, 120.0),
        (11, 1, 40.0),
        (12, 2, 90.0),
        (13, 1, 250.0)`.execute(db)

    // A key that is not called `id`, because `field: 'id'` means the row's identity rather than a
    // column of that name, and nothing proves that on a table where the two coincide.
    await sql`create table sites (site_id text primary key, label text)`.execute(db)
    await sql`insert into sites (site_id, label) values ('north', 'North plant'), ('south', 'South plant')`.execute(db)

    await sql`create table tags (customer_id integer not null, tag text not null, primary key (customer_id, tag))`.execute(db)
    await sql`create table notes (body text)`.execute(db)
    await sql`create view active_customers as select * from customers where active = 1`.execute(db)

    return db
}
