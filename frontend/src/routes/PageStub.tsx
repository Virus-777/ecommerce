import { Link } from 'react-router';
import { SCREEN_BY_ID, type ScreenId } from './catalogue';

/** Placeholder for a screen that is not ported yet. */
export function PageStub({ id }: { id: ScreenId }) {
  const s = SCREEN_BY_ID[id];
  return (
    <div className="container page stack gap-3">
      <h1 className="h1">{s.title}</h1>
      <p className="small muted">
        Not built yet. Design: <span className="mono">pages/{s.area}/{s.file}.html</span>
      </p>
      <Link to="/design">All screens</Link>
    </div>
  );
}
