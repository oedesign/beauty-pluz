Deno.serve((request: Request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405 });
  }

  const suppliedProbe = request.headers.get("x-checkout-ingress-probe");
  const observedIp = request.headers.get("cf-connecting-ip");

  return Response.json({
    headerPresent: Boolean(observedIp),
    matchesForgedProbe: observedIp === "198.51.100.77",
    probeReceived: suppliedProbe === "beauty-pluz-test",
  });
});
