// Entry point for the WidgetKit extension. WidgetKit requires exactly one
// @main type per extension; this bundle wraps the single widget we ship.
// Add more widgets here later by listing them inside `body`.

import WidgetKit
import SwiftUI

@main
struct CommonCommWidgetBundle: WidgetBundle {
    var body: some Widget {
        CommonCommWidget()
    }
}
