// Whether a result's paragraph may be opened for editing in its source file: only while the
// runs use the latest course text, since a frozen corpus can differ from the file as it is now.
import { createContext } from 'react';

export const EditableText = createContext(true);
