package httpapi

import "testing"

func TestIsBlankArticleTranslationInput(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		title       string
		markdown    string
		contentHTML string
		wantBlank   bool
	}{
		{
			name:        "blank title markdown and paragraph",
			contentHTML: "<p></p>",
			wantBlank:   true,
		},
		{
			name:        "blank title markdown and nbsp entity paragraph",
			contentHTML: "<p>&nbsp;</p>",
			wantBlank:   true,
		},
		{
			name:        "blank title markdown and numeric nbsp entity paragraph",
			contentHTML: "<p>&#160;</p>",
			wantBlank:   true,
		},
		{
			name:        "non-empty title",
			title:       "Hello",
			contentHTML: "<p></p>",
			wantBlank:   false,
		},
		{
			name:        "non-empty body",
			contentHTML: "<p>Bonjour</p>",
			wantBlank:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := isBlankArticleTranslationInput(tc.title, tc.markdown, tc.contentHTML)
			if got != tc.wantBlank {
				t.Fatalf("isBlankArticleTranslationInput() = %v, want %v", got, tc.wantBlank)
			}
		})
	}
}
