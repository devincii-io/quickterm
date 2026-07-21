import os

import pytest

from quickterm import secret_store


@pytest.mark.skipif(os.name != "nt", reason="DPAPI is Windows-only")
def test_dpapi_roundtrip_and_ciphertext_differs():
    plaintext = b"quickterm-test-secret"
    protected = secret_store.protect(plaintext)

    assert protected != plaintext
    assert plaintext not in protected
    assert secret_store.unprotect(protected) == plaintext
