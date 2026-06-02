package httpapi

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

func TestDecodeDataImageURI_HTMLUnescapesBase64Payload(t *testing.T) {
	mimeType, data, err := decodeDataImageURI("data:image/png;base64,&#43;w==")
	if err != nil {
		t.Fatalf("decodeDataImageURI returned error: %v", err)
	}
	if mimeType != "image/png" {
		t.Fatalf("expected image/png mime type, got: %s", mimeType)
	}
	if len(data) != 1 || data[0] != 0xfb {
		t.Fatalf("expected decoded byte 0xfb, got: %v", data)
	}
}

func TestConvertSVGDataURLToPNGDataURL_AcceptsEscapedSVGHeader(t *testing.T) {
	svg := "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'><rect width='1' height='1' fill='red'/></svg>"
	uri := "data:image/svg&#43;xml;utf8," + svg

	pngURI, err := convertSVGDataURLToPNGDataURL(uri)
	if err != nil {
		t.Fatalf("convertSVGDataURLToPNGDataURL returned error: %v", err)
	}
	if !strings.HasPrefix(pngURI, "data:image/png;base64,") {
		t.Fatalf("expected png data uri, got: %s", pngURI)
	}
	encoded := strings.TrimPrefix(pngURI, "data:image/png;base64,")
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decoded png base64 failed: %v", err)
	}
	if !bytes.HasPrefix(decoded, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		t.Fatalf("expected PNG signature, got: %x", decoded[:8])
	}
}

func TestConvertSVGDataURLsInHTMLToPNG_HandlesEscapedSVGMediaType(t *testing.T) {
	html := `<img src="data:image/svg&#43;xml;utf8,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%271%27%20height%3D%271%27%3E%3C%2Fsvg%3E">`
	out := convertSVGDataURLsInHTMLToPNG(html)
	if strings.Contains(out, "data:image/svg") {
		t.Fatalf("expected svg data uri to be converted, got: %s", out)
	}
	if !strings.Contains(out, "data:image/png;base64,") {
		t.Fatalf("expected png data uri after conversion, got: %s", out)
	}
}
