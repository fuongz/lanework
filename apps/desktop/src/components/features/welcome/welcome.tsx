import { Link } from "@tanstack/react-router";
import { Badge } from "#/components/ui/badge";
import { buttonVariants } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
export function Welcome() {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col items-start gap-5">
        <Badge variant="secondary">Your desktop workspace</Badge>
        <h1 className="max-w-xl text-5xl font-semibold tracking-tight">
          A little space.
          <br />
          For your next big thing.
        </h1>
        <p className="max-w-lg text-lg leading-relaxed text-muted-foreground">
          Welcome to Lanework. A quiet place to make room for the work that
          matters.
        </p>
        <Link to="/settings" className={buttonVariants()}>
          Make it yours
        </Link>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Start with a space that feels right.</CardTitle>
          <CardDescription>
            A few small preferences can make a big difference.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Choose a comfortable layout in Settings. Your preference stays with
            you when you close and reopen the app.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
