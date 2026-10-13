import { Link } from 'react-router';
import { APP_NAMES, APP_URLS, CURRENT_APP } from './apps';
import { AREAS, SCREENS } from './catalogue';
import { href } from './href';

/** /design: every screen and view, for review against the design export. */
export default function DesignIndex() {
  return (
    <main className="container page stack gap-6" id="main">
      <div className="stack gap-2">
        <h1 className="h1">{APP_NAMES[CURRENT_APP]} screens</h1>
        <p className="small sub measure-lg">
          Every screen of this app from the design, grouped by area. Each view links to the route that renders the matching design file
          (<span className="mono">pages/&lt;area&gt;/&lt;file&gt;--&lt;view&gt;.html</span>).
        </p>
        <p className="small">
          Other apps:{' '}
          {(Object.keys(APP_URLS) as Array<keyof typeof APP_URLS>)
            .filter((a) => a !== CURRENT_APP)
            .map((a, i) => (
              <span key={a}>
                {i > 0 && ' · '}
                <a href={`${APP_URLS[a]}/design`}>{APP_NAMES[a]}</a>
              </span>
            ))}
        </p>
      </div>
      {AREAS.map((a) => {
        const list = SCREENS.filter((s) => s.area === a.id && s.app === CURRENT_APP);
        if (!list.length) return null;
        const groups = [...new Set(list.map((s) => s.group))];
        return (
          <section key={a.id} className="stack gap-4">
            <h2 className="h2">
              {a.name} <span className="small muted">· {list.length} screens</span>
            </h2>
            {groups.map((g) => (
              <section key={g} className="card">
                <div className="card-head">
                  <h3 className="h4">{g}</h3>
                </div>
                <ul className="list">
                  {list
                    .filter((s) => s.group === g)
                    .map((s) => (
                      <li key={s.id} className="row between wrap gap-2">
                        <span className="stack gap-0">
                          <Link className="strong" to={href(s.id as never)}>
                            {s.title}
                          </Link>
                          <span className="xs muted mono">
                            {s.id}
                            {!s.file && <span className="badge t-info">Designed in React</span>}
                          </span>
                        </span>
                        {s.views.length > 1 && (
                          <span className="row wrap gap-2">
                            {s.views.slice(1).map((v) => (
                              <Link key={v.slug} className="chip" to={href(s.id as never, v.slug)}>
                                {v.name}
                              </Link>
                            ))}
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </section>
        );
      })}
    </main>
  );
}
