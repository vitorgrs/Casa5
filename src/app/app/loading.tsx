export default function AppLoading() {
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <div
            className="skeleton skeleton-line"
            style={{ width: 180, height: 12 }}
          />
          <div
            className="skeleton skeleton-line"
            style={{ width: 320, height: 30, marginTop: 12 }}
          />
          <div
            className="skeleton skeleton-line"
            style={{ width: 420, height: 14, marginTop: 10 }}
          />
        </div>
      </div>
      <div className="grid cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div className="card metric-card" key={index}>
            <div
              className="skeleton skeleton-line"
              style={{ width: "48%", height: 10 }}
            />
            <div
              className="skeleton skeleton-line"
              style={{ width: "65%", height: 28, marginTop: 20 }}
            />
            <div
              className="skeleton skeleton-line"
              style={{ width: "38%", height: 10, marginTop: 10 }}
            />
          </div>
        ))}
      </div>
      <div className="card pad">
        <div
          className="skeleton skeleton-line"
          style={{ width: 220, height: 18 }}
        />
        <div
          className="skeleton skeleton-line"
          style={{ width: "100%", height: 220, marginTop: 18 }}
        />
      </div>
    </div>
  );
}
