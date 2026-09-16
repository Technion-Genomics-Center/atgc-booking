// Where this page sends its sealed messages, and whose key seals them.
//
// Neither is a secret. The letterbox accepts only sealed messages, and the key
// is the public half of a pair whose private half never leaves the lab's server.
// build.py checks both before anything is published.

const BOOKING_CONFIG = {
  letterboxUrl:
    "https://script.google.com/macros/s/AKfycbxstZUs6pYj1R4txb3IWaJC7xIAlixL_1rVWtEAZzlUFIhIMTNfTrKutof_eRBV1Mh8Vg/exec",
  // Set from `make_server_key.py` on the server. Null until then; the page
  // cannot be published without it.
  serverPublicKey: null,
};
