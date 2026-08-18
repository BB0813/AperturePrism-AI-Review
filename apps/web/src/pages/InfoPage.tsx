/** Placeholder for tabs whose data pipeline is still landing (PR, Provider). */
export function InfoPage(props: { title: string; note: string }) {
  return (
    <section className="card">
      <h2>{props.title}</h2>
      <p className="state-empty">{props.note}</p>
    </section>
  );
}