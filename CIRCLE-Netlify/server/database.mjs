// Adapt the shared service's fixed, parameterized statements to PostgreSQL.
export function createDatabase(sql) {
  function prepare(source) {
    return { bind(...values) {
      let query = source;
      if (query.startsWith('INSERT OR REPLACE INTO circle_sessions')) {
        query = query.replace('INSERT OR REPLACE','INSERT') +
          ' ON CONFLICT (id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,expires_at=excluded.expires_at';
      } else if (query.startsWith('INSERT OR REPLACE INTO circle_actions')) {
        query = query.replace('INSERT OR REPLACE','INSERT') +
          ' ON CONFLICT (id) DO UPDATE SET owner=excluded.owner,target_id=excluded.target_id,username=excluded.username,operation=excluded.operation,status=excluded.status,message=excluded.message,created_at=excluded.created_at';
      }
      if (/^(INSERT|DELETE|UPDATE) /.test(query) && !/ RETURNING /i.test(query)) query += ' RETURNING id';
      const parts = query.split('?');
      if (parts.length !== values.length + 1) throw new Error('Parameter mismatch');
      Object.defineProperty(parts, 'raw', {value: [...parts]});
      async function execute() {
        const rows = await sql(parts, ...values);
        return rows.map(row => {
          const result = {...row};
          for (const field of ['expires_at','created_at']) if (result[field] != null) result[field] = Number(result[field]);
          return result;
        });
      }
      return {
        async first() { return (await execute())[0] || null; },
        async all() { return {results: await execute()}; },
        async run() { const rows = await execute(); return {meta: {changes: rows.length}}; }
      };
    }};
  }
  return {prepare, async batch(statements) { const out=[]; for(const s of statements) out.push(await s.run()); return out; }};
}
