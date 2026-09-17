// Where this page sends its sealed messages, and whose key seals them.
//
// Neither is a secret. The letterbox accepts only sealed messages, and the key
// is the public half of a pair whose private half never leaves the lab's server.
// build.py checks both before anything is published.

const BOOKING_CONFIG = {
  letterboxUrl:
    "https://script.google.com/macros/s/AKfycbxstZUs6pYj1R4txb3IWaJC7xIAlixL_1rVWtEAZzlUFIhIMTNfTrKutof_eRBV1Mh8Vg/exec",
  // The public half of the server's key, made on 2026-09-16.
  // Fingerprint b93efcbce25c08bb - check it against `make_server_key.py --show`.
  serverPublicKey:
    "BN6qsk3suYZt+N3bJ+4WkWF5BpTeEwotLtGrRxd231FH3Nv2C8gxCJz0Yc9/dfGwnH4TcnE3+QP9IoIF8+VJamo=",
};
