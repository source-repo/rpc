import { CUSTOMERS, ORDERS, SITES, type ConformanceCollection } from '@source-repo/conformance'
import { MongoClient, type Db } from 'mongodb'

/**
 * The shared conformance rows, in MongoDB.
 *
 * Two translations are worth naming, because both are the document store being itself rather than
 * an accident of this fixture.
 *
 * **`_id` is the id**, so `customers` keys on the integer the shared rows already carry rather than
 * on a generated ObjectId - which is what makes the ids in the expected answers (`'1'`, `'2'`) mean
 * the same thing here as they do over SQL. `sites` keys on its `site_id`, so the "a key that is not
 * called id" question is asked of a collection whose `_id` is a string that came from the data.
 *
 * **A null stays a null.** The rows carry `city: null` rather than omitting the field, so what is
 * being compared across backends is the same question - SQL has no way to express a missing field
 * at all, and a fixture that omitted it here would be asking Mongo something SQL was never asked.
 * What a *missing* field does differently is a separate matter, and has its own test.
 */

export const MONGO_URL = process.env.MSGRPC_TEST_MONGO ?? 'mongodb://test:test@localhost:27017/?authSource=admin'

export interface MongoFixture {
    readonly client: MongoClient
    readonly db: Db
    readonly name: { readonly [collection in ConformanceCollection]: string }
    close(): Promise<void>
}

/**
 * A database of its own per run, dropped afterwards.
 *
 * Cheaper and stricter than suffixed collection names: nothing this run does can be seen by another
 * one, and the catalogue is exactly what the fixture put there - so a test asserting which
 * collections are served is asserting something rather than filtering.
 */
export const fixture = async (run: string): Promise<MongoFixture> => {
    const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 2000 })
    await client.connect()
    const db = client.db(`sourceRpcTest_${run}`)

    await db.collection('customers').insertMany(CUSTOMERS.map(({ id, ...rest }) => ({ _id: id as unknown as never, ...rest })))
    await db.collection('orders').insertMany(ORDERS.map(({ id, ...rest }) => ({ _id: id as unknown as never, ...rest })))
    await db.collection('sites').insertMany(SITES.map(({ site_id, ...rest }) => ({ _id: site_id as unknown as never, site_id, ...rest })))

    return {
        client,
        db,
        name: { customers: 'customers', orders: 'orders', sites: 'sites' },
        close: async () => {
            await db.dropDatabase().catch(() => undefined)
            await client.close().catch(() => undefined)
        }
    }
}
